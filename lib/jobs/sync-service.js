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
  RAW_SYNC_METRICS,
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

function datesInRange(startDate, endDateExclusive) {
  const dates = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDateExclusive}T12:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
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
  rawRetentionDays = null,
  rawPruningEnabled = false,
  now = () => Date.now(),
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },
}) {
  const retentionDays =
    Number.isInteger(Number(rawRetentionDays)) && Number(rawRetentionDays) > 0
      ? Number(rawRetentionDays)
      : null;
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
    if (chunk.metric === 'sleep') {
      const normalized = normalizeSleepResponse({
        dataPoints: data.dataPoints ?? [],
        startDate: dateOnly(chunk.start_date),
        endDateExclusive: dateOnly(chunk.end_date_exclusive),
      });
      const sessions = [...normalized.nights, ...normalized.naps];
      await writer.upsertSleepSessions(chunk.source_account_id, sessions);
    } else if (chunk.metric === 'heart-rate') {
      const samples = normalizeHeartRateSamples(data);
      await writer.upsertHeartSamples(chunk.source_account_id, samples);
    } else if (chunk.metric === 'daily-resting-heart-rate') {
      const summaries = normalizeDailyRestingHeartRate(data);
      await writer.upsertRestingHeartRateDaily(chunk.source_account_id, summaries);
    } else {
      const metricType = {
        'total-calories': 'total',
        'active-energy-burned': 'active',
        'basal-energy-burned': 'basal',
      }[chunk.metric];
      const intervals = normalizeCalorieIntervals(data, metricType);
      await writer.upsertCalorieIntervals(chunk.source_account_id, intervals);
    }
  }

  const service = {
    async enqueue({
      mode = 'recent',
      startDate,
      endDateExclusive,
      metrics = DEFAULT_SYNC_METRICS,
      requestedBy = 'system',
      recentDays = 7,
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
            : recentRange(end, recentDays).startDate;
      }
      if (!validCivilDate(start) || !validCivilDate(end) || start >= end) {
        throw badRequest('startDate and endDateExclusive must form a valid closed-open range');
      }
      const selectedMetrics = [...new Set(metrics)];
      const retentionStart = retentionDays
        ? recentRange(tomorrow(now(), account.timezone), retentionDays).startDate
        : null;
      const selectedRawMetrics = selectedMetrics.filter((metric) =>
        RAW_SYNC_METRICS.includes(metric),
      );
      if (
        mode === 'custom' &&
        retentionStart &&
        start < retentionStart &&
        selectedRawMetrics.length
      ) {
        throw badRequest(
          `${retentionDays}-day raw retention only allows custom raw metric ranges starting on or after ${retentionStart}`,
        );
      }
      const metricStartDates = {};
      if (mode === 'backfill' && retentionStart) {
        for (const metric of selectedRawMetrics) {
          metricStartDates[metric] = start < retentionStart ? retentionStart : start;
        }
      }
      const chunks = planSyncChunks({
        metrics: selectedMetrics,
        startDate: start,
        endDateExclusive: end,
        metricStartDates,
      });
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
        let completedJobStatus = null;
        const completed = await repository.completeChunk(chunk, {
          nextPageToken: response.nextPageToken,
          async beforeCommit({ client, jobStatus }) {
            completedJobStatus = jobStatus;
            if (jobStatus !== 'completed') return;
            const job = (
              await client.query(
                `SELECT source_account_id, start_date, end_date_exclusive
                 FROM sync_jobs WHERE id = $1`,
                [chunk.sync_job_id],
              )
            ).rows[0];
            if (!job) return;
            for (const date of datesInRange(
              dateOnly(job.start_date),
              dateOnly(job.end_date_exclusive),
            )) {
              await writer.recalculateDaily(job.source_account_id, date, client);
            }
          },
        });
        if (
          completed &&
          completedJobStatus === 'completed' &&
          rawPruningEnabled &&
          retentionDays &&
          writer.pruneRawMetricsBefore
        ) {
          const cutoffDate = recentRange(tomorrow(now(), chunk.timezone), retentionDays).startDate;
          try {
            await writer.pruneRawMetricsBefore(chunk.source_account_id, cutoffDate);
          } catch (error) {
            console.error('Raw metric retention failed', { message: error.message });
          }
        }
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
      scheduledLookbackDays = 7,
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
        scheduleTimer = timers.setInterval(
          () =>
            service
              .enqueue({
                mode: 'recent',
                requestedBy: 'schedule',
                recentDays: scheduledLookbackDays,
              })
              .catch((error) => {
                console.error('Scheduled sync could not be queued', { message: error.message });
              }),
          syncIntervalMs,
        );
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
