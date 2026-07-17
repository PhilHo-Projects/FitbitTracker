import crypto from 'node:crypto';

import {
  normalizeCalorieIntervals,
  normalizeDailyRestingHeartRate,
  normalizeHeartRateSamples,
} from '../metrics/normalizers.js';
import { normalizeSleepResponse } from '../sleep-normalizer.js';
import {
  DEFAULT_SYNC_METRICS,
  GOOGLE_HEALTH_METRICS,
  planSyncChunks,
  recentRange,
} from './planner.js';

function civilDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function tomorrow(now, timezone) {
  const date = new Date(`${civilDate(now, timezone)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function uniqueDates(records) {
  return [...new Set(records.map(({ civilDate, date }) => civilDate ?? date).filter(Boolean))];
}

function profileDate(value, fallback) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value?.year && value?.month && value?.day) {
    return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
  }
  return fallback;
}

function dateOnly(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return value ? new Date(value).toISOString().slice(0, 10) : null;
}

function validCivilDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function createSyncService({
  pool,
  repository,
  gateway,
  writer,
  workerId = `worker-${process.pid}`,
  now = () => Date.now(),
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },
}) {
  let pollTimer = null;
  let scheduleTimer = null;
  let running = false;

  async function ensureSourceAccount() {
    const existing = (
      await pool.query('SELECT * FROM source_accounts ORDER BY created_at LIMIT 1')
    ).rows[0];
    if (existing) return existing;

    const [profile, identity] = await Promise.all([
      gateway.request({ operation: 'profile', metric: 'sleep' }),
      gateway.request({ operation: 'identity', metric: 'sleep' }),
    ]);
    const profileData = profile.data ?? {};
    const identityData = identity.data ?? {};
    const id = crypto.randomUUID();
    return (
      await pool.query(
        `INSERT INTO source_accounts (
          id, provider, provider_account_id, display_name, timezone, membership_start_date, profile
        ) VALUES ($1, 'google-health', $2, $3, $4, $5, $6)
        ON CONFLICT (provider, provider_account_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          timezone = EXCLUDED.timezone,
          membership_start_date = EXCLUDED.membership_start_date,
          profile = EXCLUDED.profile,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *`,
        [
          id,
          identityData.healthUserId ??
            identityData.health_user_id ??
            identityData.userId ??
            identityData.name ??
            'users/me',
          profileData.displayName ?? identityData.displayName ?? null,
          profileData.timezone ?? 'America/Toronto',
          profileDate(
            profileData.membershipStartDate,
            new Date(now()).toISOString().slice(0, 10),
          ),
          profileData,
        ],
      )
    ).rows[0];
  }

  async function ingest(chunk, response) {
    const data = response.data ?? {};
    let affectedDates = [];
    if (chunk.metric === 'sleep') {
      const normalized = normalizeSleepResponse({
        dataPoints: data.dataPoints ?? [],
        startDate: String(chunk.start_date).slice(0, 10),
        endDateExclusive: String(chunk.end_date_exclusive).slice(0, 10),
      });
      const sessions = [...normalized.nights, ...normalized.naps];
      await writer.upsertSleepSessions(chunk.source_account_id, sessions);
      affectedDates = uniqueDates(sessions);
    } else if (chunk.metric === 'heart-rate') {
      const samples = normalizeHeartRateSamples(data);
      await writer.upsertHeartSamples(chunk.source_account_id, samples);
      affectedDates = uniqueDates(samples);
    } else if (chunk.metric === 'daily-resting-heart-rate') {
      const summaries = normalizeDailyRestingHeartRate(data);
      await writer.upsertRestingHeartRateDaily(chunk.source_account_id, summaries);
      affectedDates = uniqueDates(summaries);
    } else {
      const metricType = {
        'total-calories': 'total',
        'active-energy-burned': 'active',
        'basal-energy-burned': 'basal',
      }[chunk.metric];
      const intervals = normalizeCalorieIntervals(data, metricType);
      await writer.upsertCalorieIntervals(chunk.source_account_id, intervals);
      affectedDates = uniqueDates(intervals);
    }
    for (const date of affectedDates) {
      await writer.recalculateDaily(chunk.source_account_id, date);
    }
  }

  const service = {
    async enqueue({
      mode = 'recent',
      startDate,
      endDateExclusive,
      metrics = DEFAULT_SYNC_METRICS,
      requestedBy = 'system',
    } = {}) {
      if (!['recent', 'backfill', 'custom'].includes(mode)) {
        throw badRequest('mode must be recent, backfill, or custom');
      }
      if (
        !Array.isArray(metrics) ||
        !metrics.length ||
        metrics.some((metric) => !GOOGLE_HEALTH_METRICS.includes(metric))
      ) {
        throw badRequest('At least one supported metric is required');
      }
      const account = await ensureSourceAccount();
      const end = endDateExclusive || tomorrow(now(), account.timezone);
      let start = startDate;
      if (!start) {
        start =
          mode === 'backfill'
            ? dateOnly(account.membership_start_date)
            : recentRange(end, 7).startDate;
      }
      if (!validCivilDate(start) || !validCivilDate(end) || start >= end) {
        throw badRequest('startDate and endDateExclusive must form a valid closed-open range');
      }
      const selectedMetrics = [...new Set(metrics)];
      const chunks = planSyncChunks({ metrics: selectedMetrics, startDate: start, endDateExclusive: end });
      return repository.enqueue({
        sourceAccountId: account.id,
        jobType: mode === 'backfill' ? 'backfill' : mode === 'custom' ? 'custom' : 'incremental',
        requestedBy,
        startDate: start,
        endDateExclusive: end,
        metrics: selectedMetrics,
        chunks,
        priority: mode === 'recent' ? 10 : 0,
      });
    },

    status: () => repository.status(),

    async runOnce() {
      const chunk = await repository.claimNextChunk(workerId);
      if (!chunk) return false;
      try {
        const response = await gateway.request({
          operation: chunk.operation,
          metric: chunk.metric,
          startDate: dateOnly(chunk.start_date),
          endDateExclusive: dateOnly(chunk.end_date_exclusive),
          pageToken: chunk.page_token,
          timezone: chunk.timezone,
        });
        await ingest(chunk, response);
        await repository.completeChunk(chunk, { nextPageToken: response.nextPageToken });
      } catch (error) {
        const attempt = Number(chunk.attempt_count || 1);
        await repository.failChunk(chunk, error, {
          retryable: error.transient !== false,
          maxAttempts: 4,
          delayMs: Math.min(60_000, 1000 * 2 ** (attempt - 1)),
        });
      }
      return true;
    },

    start({
      pollIntervalMs = 1000,
      syncIntervalMs = 3 * 60 * 60 * 1000,
      scheduleEnabled = true,
    } = {}) {
      if (running) return;
      running = true;
      const poll = async () => {
        if (!running) return;
        try {
          await service.runOnce();
        } catch (error) {
          console.error('Sync worker failed', { message: error.message });
        } finally {
          if (running) pollTimer = timers.setTimeout(poll, pollIntervalMs);
        }
      };
      repository
        .recoverStaleClaims?.()
        .catch((error) => {
          console.error('Stale sync claims could not be recovered', { message: error.message });
        })
        .finally(() => {
          if (running) pollTimer = timers.setTimeout(poll, 0);
        });
      if (scheduleEnabled) {
        scheduleTimer = timers.setInterval(() => {
          service.enqueue({ mode: 'recent', requestedBy: 'schedule' }).catch((error) => {
            console.error('Scheduled sync could not be queued', { message: error.message });
          });
        }, syncIntervalMs);
      }
    },

    stop() {
      running = false;
      timers.clearTimeout(pollTimer);
      timers.clearInterval(scheduleTimer);
    },
  };

  return service;
}
