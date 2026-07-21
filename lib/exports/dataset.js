import { createRawAvailabilityReader } from '../db/raw-availability.js';

const ALLOWED_METRICS = ['sleep', 'heart', 'calories'];

function dateOnly(value) {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function numeric(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function minutes(value) {
  const parsed = numeric(value);
  return parsed === null ? null : Math.round((parsed / 60) * 100) / 100;
}

function json(value) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function selectedMetrics(metrics) {
  const selected = [...new Set(Array.isArray(metrics) ? metrics : ALLOWED_METRICS)];
  if (!selected.length || selected.some((metric) => !ALLOWED_METRICS.includes(metric))) {
    throw Object.assign(new Error('metrics must contain sleep, heart, and/or calories'), { status: 400 });
  }
  return selected;
}

function rangeDates(startDate, endDateExclusive) {
  const dates = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDateExclusive}T12:00:00Z`);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function mapDaily(row, metrics) {
  const sleep = metrics.includes('sleep');
  const heart = metrics.includes('heart');
  const calories = metrics.includes('calories');
  return {
    date: dateOnly(row.civil_date),
    sleepDurationMinutes: sleep ? minutes(row.sleep_duration_seconds) : null,
    sleepAsleepMinutes: sleep ? minutes(row.sleep_asleep_seconds) : null,
    sleepAwakeMinutes: sleep ? minutes(row.sleep_awake_seconds) : null,
    sleepEfficiencyPercent: sleep ? numeric(row.sleep_efficiency) : null,
    heartRestingBpm: heart ? numeric(row.heart_resting_bpm) : null,
    heartAverageBpm: heart ? numeric(row.heart_average_bpm) : null,
    heartMinimumBpm: heart ? numeric(row.heart_minimum_bpm) : null,
    heartMaximumBpm: heart ? numeric(row.heart_maximum_bpm) : null,
    heartSampleCount: heart ? numeric(row.heart_sample_count) : null,
    calorieTotalKcal: calories ? numeric(row.calorie_total_kcal) : null,
    calorieActiveKcal: calories ? numeric(row.calorie_active_kcal) : null,
    calorieBasalKcal: calories ? numeric(row.calorie_basal_kcal) : null,
    coverage: json(row.coverage),
    derivations: json(row.derivations),
  };
}

function mapSession(row) {
  return {
    providerKey: row.provider_key,
    providerId: row.provider_id,
    civilDate: dateOnly(row.civil_date),
    startTime: iso(row.start_time),
    endTime: iso(row.end_time),
    startOffsetSeconds: numeric(row.start_offset_seconds),
    endOffsetSeconds: numeric(row.end_offset_seconds),
    sleepType: row.sleep_type,
    isNap: Boolean(row.is_nap),
    durationSeconds: numeric(row.duration_seconds),
    asleepSeconds: numeric(row.asleep_seconds),
    awakeSeconds: numeric(row.awake_seconds),
    efficiencyPercent: numeric(row.efficiency),
    timeToSleepSeconds: numeric(row.time_to_sleep_seconds),
    awakeEpisodes: numeric(row.awake_episodes),
    device: json(row.device),
    sourceFields: json(row.source_fields),
  };
}

function mapStage(row) {
  return {
    sessionProviderKey: row.session_provider_key,
    civilDate: dateOnly(row.civil_date),
    providerKey: row.provider_key,
    sequence: numeric(row.sequence),
    stageType: row.stage_type,
    startTime: iso(row.start_time),
    endTime: iso(row.end_time),
    durationSeconds: numeric(row.duration_seconds),
    sourceFields: json(row.source_fields),
  };
}

function mapHeartSample(row) {
  return {
    providerKey: row.provider_key,
    providerId: row.provider_id,
    civilDate: row.civil_date_text ?? dateOnly(row.civil_date),
    sampledAt: row.sampled_at_text ?? iso(row.sampled_at),
    utcOffsetSeconds: numeric(row.utc_offset_seconds),
    beatsPerMinute: numeric(row.beats_per_minute),
    device: json(row.device),
    sourceFields: json(row.source_fields),
  };
}

function mapCalorieInterval(row) {
  return {
    providerKey: row.provider_key,
    providerId: row.provider_id,
    civilDate: row.civil_date_text ?? dateOnly(row.civil_date),
    metricType: row.metric_type,
    startTime: row.start_time_text ?? iso(row.start_time),
    endTime: row.end_time_text ?? iso(row.end_time),
    utcOffsetSeconds: numeric(row.utc_offset_seconds),
    kilocalories: numeric(row.kilocalories),
    device: json(row.device),
    sourceFields: json(row.source_fields),
  };
}

async function collect(iterable) {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

export function createAnalysisDatasetService({
  pool,
  journalRepository = null,
  batchSize = 2_000,
  availabilityOptions = {},
}) {
  const rawAvailability = createRawAvailabilityReader(pool, availabilityOptions);
  const memoryDatabase = pool.constructor?.name === 'MemPg';
  const timestampText = (column, alias) => memoryDatabase
    ? `${column} AS ${alias}`
    : `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`;
  const civilDateText = memoryDatabase ? 'civil_date AS civil_date_text' : 'civil_date::text AS civil_date_text';
  async function account() {
    return (
      await pool.query(
        `SELECT id, provider, provider_account_id, display_name, timezone, membership_start_date
         FROM source_accounts
         ORDER BY created_at
         LIMIT 1`,
      )
    ).rows[0] ?? null;
  }

  async function* pagedRows(sql, params, mapper) {
    let cursor = null;
    while (true) {
      const cursorParameter = params.length + 1;
      const limitParameter = params.length + 2;
      const result = await pool.query(`${sql}
       AND ($${cursorParameter}::uuid IS NULL OR id > $${cursorParameter}::uuid)
       ORDER BY id
       LIMIT $${limitParameter}`, [
        ...params,
        cursor,
        batchSize,
      ]);
      for (const row of result.rows) yield mapper(row);
      if (result.rows.length < batchSize) break;
      cursor = result.rows.at(-1).id;
    }
  }

  async function* heartRateSampleRows(range, sourceAccountId) {
    yield* pagedRows(
      `SELECT *, ${civilDateText}, ${timestampText('sampled_at', 'sampled_at_text')}
       FROM heart_rate_samples
       WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3
      `,
      [sourceAccountId, range.startDate, range.endDateExclusive],
      mapHeartSample,
    );
  }

  async function* calorieIntervalRows(range, sourceAccountId) {
    yield* pagedRows(
      `SELECT *,
              ${civilDateText},
              ${timestampText('start_time', 'start_time_text')},
              ${timestampText('end_time', 'end_time_text')}
       FROM calorie_intervals
       WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3
      `,
      [sourceAccountId, range.startDate, range.endDateExclusive],
      mapCalorieInterval,
    );
  }

  return {
    async buildAnalysisDataset(
      range,
      metrics = ALLOWED_METRICS,
      detailLevel = 'analysis',
      includeJournal = false,
      { loadRawRecords = true } = {},
    ) {
      const selected = selectedMetrics(metrics);
      if (!['analysis', 'full'].includes(detailLevel)) {
        throw Object.assign(new Error('detailLevel must be analysis or full'), { status: 400 });
      }
      const source = await account();
      if (!source) throw Object.assign(new Error('No source account is configured'), { status: 409 });
      if (includeJournal && !journalRepository) {
        throw Object.assign(new Error('Journal encryption is not configured'), { status: 409 });
      }

      const [dailyResult, sessionsResult, stagesResult, journal] = await Promise.all([
        pool.query(
          `SELECT *
           FROM daily_health_summaries
           WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3
           ORDER BY civil_date`,
          [source.id, range.startDate, range.endDateExclusive],
        ),
        selected.includes('sleep')
          ? pool.query(
              `SELECT *
               FROM sleep_sessions
               WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3
               ORDER BY civil_date, start_time`,
              [source.id, range.startDate, range.endDateExclusive],
            )
          : { rows: [] },
        selected.includes('sleep')
          ? pool.query(
              `SELECT stage.*, session.provider_key AS session_provider_key, session.civil_date
               FROM sleep_stages stage
               JOIN sleep_sessions session ON session.id = stage.sleep_session_id
               WHERE session.source_account_id = $1
                 AND session.civil_date >= $2
                 AND session.civil_date < $3
               ORDER BY session.civil_date, session.start_time, stage.sequence`,
              [source.id, range.startDate, range.endDateExclusive],
            )
          : { rows: [] },
        includeJournal
          ? journalRepository.list({
              startDate: range.startDate,
              endDateExclusive: range.endDateExclusive,
            })
          : [],
      ]);

      const dailySummaries = dailyResult.rows.map((row) => mapDaily(row, selected));
      const daysWithSummary = new Set(dailySummaries.map(({ date }) => date));
      const missingDateWarnings = rangeDates(range.startDate, range.endDateExclusive)
        .filter((date) => !daysWithSummary.has(date))
        .map((date) => ({
          date,
          metrics: selected,
          message: 'No normalized daily summary is available for this date.',
        }));
      const partialCoverageWarnings = dailySummaries.flatMap((summary) => {
        const affectedMetrics = selected.filter(
          (metric) => summary.coverage?.[metric] !== 'complete',
        );
        return affectedMetrics.length
          ? [
              {
                date: summary.date,
                metrics: affectedMetrics,
                message: 'One or more requested metrics have partial or missing coverage.',
              },
            ]
          : [];
      });
      const coverageWarnings = [
        ...missingDateWarnings,
        ...partialCoverageWarnings,
      ].sort((left, right) => left.date.localeCompare(right.date));

      let heartRateSamples = [];
      let calorieIntervals = [];
      if (detailLevel === 'full' && loadRawRecords) {
        [heartRateSamples, calorieIntervals] = await Promise.all([
          selected.includes('heart') ? collect(heartRateSampleRows(range, source.id)) : [],
          selected.includes('calories') ? collect(calorieIntervalRows(range, source.id)) : [],
        ]);
      }

      return {
        schemaVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        range,
        timezone: source.timezone,
        units: {
          sleep: 'minutes',
          heartRate: 'beats per minute',
          calories: 'kilocalories',
        },
        sources: [
          {
            provider: source.provider,
            providerAccountId: source.provider_account_id,
            displayName: source.display_name,
            membershipStartDate: dateOnly(source.membership_start_date),
          },
        ],
        metrics: selected,
        detailLevel,
        journalIncluded: Boolean(includeJournal),
        dailySummaries,
        sleepSessions: sessionsResult.rows.map(mapSession),
        sleepStages: stagesResult.rows.map(mapStage),
        heartRateSamples,
        calorieIntervals,
        journal,
        coverageWarnings,
        derivationFlags: dailySummaries.map(({ date, derivations }) => ({ date, ...derivations })),
      };
    },

    async rawCounts(range, metrics = ALLOWED_METRICS) {
      const selected = selectedMetrics(metrics);
      const source = await account();
      if (!source) return { heartRateSamples: 0, calorieIntervals: 0 };
      const [heart, calories] = await Promise.all([
        selected.includes('heart')
          ? pool.query(
              `SELECT COUNT(*) AS count FROM heart_rate_samples
               WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3`,
              [source.id, range.startDate, range.endDateExclusive],
            )
          : { rows: [{ count: 0 }] },
        selected.includes('calories')
          ? pool.query(
              `SELECT COUNT(*) AS count FROM calorie_intervals
               WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3`,
              [source.id, range.startDate, range.endDateExclusive],
            )
          : { rows: [{ count: 0 }] },
      ]);
      return {
        heartRateSamples: Number(heart.rows[0].count),
        calorieIntervals: Number(calories.rows[0].count),
      };
    },

    async rawCoverage(range, metrics = ALLOWED_METRICS) {
      const selected = selectedMetrics(metrics);
      const source = await account();
      if (!source) return { exactLocal: {}, coldArchiveMonths: [], summaryOnlyMonths: [] };
      return rawAvailability.exportCoverage(source.id, range, selected);
    },

    async streamHeartRateSamples(range) {
      const source = await account();
      return source ? heartRateSampleRows(range, source.id) : (async function* empty() {})();
    },

    async streamCalorieIntervals(range) {
      const source = await account();
      return source ? calorieIntervalRows(range, source.id) : (async function* empty() {})();
    },
  };
}
