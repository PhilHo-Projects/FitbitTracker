import { createCompactMetricWriter } from './compact-metric-writer.js';
import { createMetricWriter } from './metric-writer.js';
import { hashSourceMetadata, sourceMetadataForRecord } from '../metrics/source-metadata.js';

function positiveBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('Compact health batch size must be a positive integer');
  }
  return parsed;
}

export function parseCompactHealthArgs(args, { defaultBatchSize = 1000 } = {}) {
  let mode = 'validate';
  let execute = false;
  let batchSize = positiveBatchSize(defaultBatchSize);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--validate') mode = 'validate';
    else if (option === '--backfill') mode = 'backfill';
    else if (option === '--execute') execute = true;
    else if (option === '--batch-size') batchSize = positiveBatchSize(args[++index]);
    else if (option.startsWith('--batch-size=')) {
      batchSize = positiveBatchSize(option.slice('--batch-size='.length));
    } else {
      throw new Error(`Unknown compact health option: ${option}`);
    }
  }
  if (execute && mode !== 'backfill') throw new Error('--execute requires --backfill');
  return { mode, execute, batchSize };
}

function civilDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function instant(value) {
  return typeof value === 'string' ? value : new Date(value).toISOString();
}

function mapHeart(row) {
  return {
    providerId: row.provider_id ?? null,
    civilDate: civilDate(row.civil_date),
    sampledAt: instant(row.sampled_at),
    utcOffsetSeconds: row.utc_offset_seconds ?? null,
    beatsPerMinute: Number(row.beats_per_minute),
    device: row.device ?? {},
    sourceFields: row.source_fields ?? {},
  };
}

function mapCalories(row) {
  return {
    providerId: row.provider_id ?? null,
    civilDate: civilDate(row.civil_date),
    metricType: row.metric_type,
    startTime: instant(row.start_time),
    endTime: instant(row.end_time),
    utcOffsetSeconds: row.utc_offset_seconds ?? null,
    kilocalories: Number(row.kilocalories),
    device: row.device ?? {},
    sourceFields: row.source_fields ?? {},
  };
}

const legacyMetrics = {
  heart: {
    sql: `SELECT id, provider_id, civil_date, sampled_at, utc_offset_seconds,
            beats_per_minute, device, source_fields
          FROM heart_rate_samples
          WHERE source_account_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
          ORDER BY id LIMIT $3`,
    map: mapHeart,
    semanticKey(record) {
      const metadataHash = hashSourceMetadata(sourceMetadataForRecord(record, 'heart-rate'));
      return `${metadataHash}:${new Date(record.sampledAt).toISOString()}`;
    },
  },
  calories: {
    sql: `SELECT id, provider_id, civil_date, metric_type, start_time, end_time,
            utc_offset_seconds, kilocalories, device, source_fields
          FROM calorie_intervals
          WHERE source_account_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
          ORDER BY id LIMIT $3`,
    map: mapCalories,
    semanticKey(record) {
      const dataType = {
        total: 'total-calories',
        active: 'active-energy-burned',
        basal: 'basal-energy-burned',
      }[record.metricType];
      const metadataHash = hashSourceMetadata(sourceMetadataForRecord(record, dataType));
      return `${metadataHash}:${record.metricType}:${new Date(record.startTime).toISOString()}`;
    },
  },
};

async function scanLegacy(pool, sourceAccountId, metric, batchSize, visit) {
  const definition = legacyMetrics[metric];
  let cursor = null;
  for (;;) {
    const rows = (await pool.query(definition.sql, [sourceAccountId, cursor, batchSize])).rows;
    if (!rows.length) return;
    const records = rows.map(definition.map);
    await visit(records);
    cursor = rows.at(-1).id;
  }
}

const heartValidationSql = `
  WITH legacy AS (
    SELECT source_account_id, civil_date, COUNT(*)::bigint AS sample_count,
      MIN(sampled_at) AS first_sampled_at, MAX(sampled_at) AS last_sampled_at,
      ROUND(SUM(beats_per_minute)::numeric, 2) AS bpm_sum,
      ROUND(MIN(beats_per_minute)::numeric, 2) AS minimum_bpm,
      ROUND(MAX(beats_per_minute)::numeric, 2) AS maximum_bpm,
      LEAST(86400, COUNT(DISTINCT FLOOR(EXTRACT(EPOCH FROM sampled_at) / 300)) * 300)::bigint
        AS coverage_seconds,
      ROUND((PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY beats_per_minute))::numeric, 2)
        AS p05_bpm,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY beats_per_minute))::numeric, 2)
        AS median_bpm,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY beats_per_minute))::numeric, 2)
        AS p95_bpm
    FROM heart_rate_samples GROUP BY source_account_id, civil_date
  ), compact AS (
    SELECT source_account_id, civil_date, COUNT(*)::bigint AS sample_count,
      MIN(sampled_at) AS first_sampled_at, MAX(sampled_at) AS last_sampled_at,
      ROUND(SUM(beats_per_minute)::numeric, 2) AS bpm_sum,
      ROUND(MIN(beats_per_minute)::numeric, 2) AS minimum_bpm,
      ROUND(MAX(beats_per_minute)::numeric, 2) AS maximum_bpm,
      LEAST(86400, COUNT(DISTINCT FLOOR(EXTRACT(EPOCH FROM sampled_at) / 300)) * 300)::bigint
        AS coverage_seconds,
      ROUND((PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY beats_per_minute))::numeric, 2)
        AS p05_bpm,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY beats_per_minute))::numeric, 2)
        AS median_bpm,
      ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY beats_per_minute))::numeric, 2)
        AS p95_bpm
    FROM heart_rate_samples_compact GROUP BY source_account_id, civil_date
  )
  SELECT COALESCE(legacy.source_account_id, compact.source_account_id) AS source_account_id,
    COALESCE(legacy.civil_date, compact.civil_date) AS civil_date,
    ROW_TO_JSON(legacy) AS legacy, ROW_TO_JSON(compact) AS compact,
    ROW_TO_JSON(summary) AS summary
  FROM legacy
  FULL OUTER JOIN compact USING (source_account_id, civil_date)
  LEFT JOIN heart_rate_daily_summaries AS summary
    ON summary.source_account_id = COALESCE(legacy.source_account_id, compact.source_account_id)
   AND summary.civil_date = COALESCE(legacy.civil_date, compact.civil_date)
  WHERE ROW(legacy.sample_count, legacy.first_sampled_at, legacy.last_sampled_at,
            legacy.bpm_sum, legacy.minimum_bpm, legacy.maximum_bpm, legacy.coverage_seconds,
            legacy.p05_bpm, legacy.median_bpm, legacy.p95_bpm)
    IS DISTINCT FROM
        ROW(compact.sample_count, compact.first_sampled_at, compact.last_sampled_at,
            compact.bpm_sum, compact.minimum_bpm, compact.maximum_bpm, compact.coverage_seconds,
            compact.p05_bpm, compact.median_bpm, compact.p95_bpm)
     OR ROW(legacy.sample_count, legacy.bpm_sum, legacy.minimum_bpm, legacy.maximum_bpm,
            legacy.coverage_seconds, legacy.p05_bpm, legacy.median_bpm, legacy.p95_bpm)
    IS DISTINCT FROM
        ROW(summary.sample_count, summary.bpm_sum, summary.minimum_bpm, summary.maximum_bpm,
            summary.coverage_seconds, summary.p05_bpm, summary.median_bpm, summary.p95_bpm)
  ORDER BY 1, 2`;

function calorieAggregate(source, startColumn, endColumn, typeColumn) {
  return `
    ${source}_ordered AS (
      SELECT source_account_id, civil_date, ${startColumn} AS start_at, ${endColumn} AS end_at,
        MAX(${endColumn}) OVER (
          PARTITION BY source_account_id, civil_date ORDER BY ${startColumn}, ${endColumn}
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ) AS previous_end
      FROM ${source === 'legacy' ? 'calorie_intervals' : 'calorie_intervals_compact'}
    ), ${source}_marked AS (
      SELECT *, CASE WHEN previous_end IS NULL OR start_at > previous_end THEN 1 ELSE 0 END AS new_group
      FROM ${source}_ordered
    ), ${source}_grouped AS (
      SELECT *, SUM(new_group) OVER (
        PARTITION BY source_account_id, civil_date ORDER BY start_at, end_at
      ) AS interval_group
      FROM ${source}_marked
    ), ${source}_coverage AS (
      SELECT source_account_id, civil_date,
        LEAST(86400, ROUND(SUM(EXTRACT(EPOCH FROM island_end - island_start))))::bigint
          AS coverage_seconds
      FROM (
        SELECT source_account_id, civil_date, interval_group,
          MIN(start_at) AS island_start, MAX(end_at) AS island_end
        FROM ${source}_grouped GROUP BY source_account_id, civil_date, interval_group
      ) islands GROUP BY source_account_id, civil_date
    ), ${source} AS (
      SELECT metric_rows.source_account_id, metric_rows.civil_date, COUNT(*)::bigint AS interval_count,
        MIN(${startColumn}) AS first_started_at, MAX(${endColumn}) AS last_ended_at,
        ROUND(SUM(kilocalories)::numeric, 4) AS kilocalorie_sum,
        ROUND((SUM(kilocalories) FILTER (WHERE ${typeColumn} = 'total'))::numeric, 4)
          AS total_kcal,
        ROUND((SUM(kilocalories) FILTER (WHERE ${typeColumn} = 'active'))::numeric, 4)
          AS active_kcal,
        ROUND((SUM(kilocalories) FILTER (WHERE ${typeColumn} = 'basal'))::numeric, 4)
          AS basal_kcal,
        ROUND(MIN(kilocalories)::numeric, 4) AS minimum_kilocalories,
        ROUND(MAX(kilocalories)::numeric, 4) AS maximum_kilocalories,
        coverage.coverage_seconds
      FROM ${source === 'legacy' ? 'calorie_intervals' : 'calorie_intervals_compact'} AS metric_rows
      JOIN ${source}_coverage AS coverage USING (source_account_id, civil_date)
      GROUP BY metric_rows.source_account_id, metric_rows.civil_date, coverage.coverage_seconds
    )`;
}

const calorieValidationSql = `
  WITH ${calorieAggregate('legacy', 'start_time', 'end_time', 'metric_type')},
       ${calorieAggregate('compact', 'start_at', 'end_at', 'interval_type')}
  SELECT COALESCE(legacy.source_account_id, compact.source_account_id) AS source_account_id,
    COALESCE(legacy.civil_date, compact.civil_date) AS civil_date,
    ROW_TO_JSON(legacy) AS legacy, ROW_TO_JSON(compact) AS compact,
    ROW_TO_JSON(summary) AS summary
  FROM legacy FULL OUTER JOIN compact USING (source_account_id, civil_date)
  LEFT JOIN calorie_daily_summaries AS summary
    ON summary.source_account_id = COALESCE(legacy.source_account_id, compact.source_account_id)
   AND summary.civil_date = COALESCE(legacy.civil_date, compact.civil_date)
  WHERE ROW(legacy.interval_count, legacy.first_started_at, legacy.last_ended_at,
            legacy.kilocalorie_sum, legacy.total_kcal, legacy.active_kcal, legacy.basal_kcal,
            legacy.minimum_kilocalories,
            legacy.maximum_kilocalories, legacy.coverage_seconds)
    IS DISTINCT FROM
        ROW(compact.interval_count, compact.first_started_at, compact.last_ended_at,
            compact.kilocalorie_sum, compact.total_kcal, compact.active_kcal, compact.basal_kcal,
            compact.minimum_kilocalories,
            compact.maximum_kilocalories, compact.coverage_seconds)
     OR ROW(
          ROUND((CASE WHEN legacy.total_kcal IS NULL
            THEN COALESCE(legacy.active_kcal, 0) + COALESCE(legacy.basal_kcal, 0)
            ELSE legacy.total_kcal END)::numeric, 2),
          ROUND(legacy.active_kcal::numeric, 2),
          ROUND(legacy.basal_kcal::numeric, 2),
          legacy.interval_count, legacy.coverage_seconds, legacy.total_kcal IS NULL
        ) IS DISTINCT FROM ROW(
          ROUND(summary.total_kcal::numeric, 2),
          ROUND(summary.active_kcal::numeric, 2),
          ROUND(summary.basal_kcal::numeric, 2),
          summary.interval_count, summary.coverage_seconds, summary.total_derived
        )
  ORDER BY 1, 2`;

async function validateCompactHealth(pool) {
  const [heart, calories] = await Promise.all([
    pool.query(heartValidationSql),
    pool.query(calorieValidationSql),
  ]);
  const mismatches = { heart: heart.rows, calories: calories.rows };
  return { valid: !heart.rows.length && !calories.rows.length, mismatches };
}

function addCounts(target, counts) {
  target.inserted += Number(counts?.inserted || 0);
  target.updated += Number(counts?.updated || 0);
  target.unchanged += Number(counts?.unchanged || 0);
}

export async function runCompactHealthOperation({
  pool,
  mode = 'validate',
  execute = false,
  batchSize = 1000,
  compactWriter = createCompactMetricWriter(pool),
  metricWriter = createMetricWriter(pool),
} = {}) {
  const boundedBatchSize = positiveBatchSize(batchSize);
  if (!['validate', 'backfill'].includes(mode)) throw new Error(`Unsupported compact health mode: ${mode}`);
  if (execute && mode !== 'backfill') throw new Error('execute requires backfill mode');
  if (mode === 'validate') return validateCompactHealth(pool);

  const result = {
    dryRun: !execute,
    sourceRows: { heart: 0, calories: 0 },
    compactWrites: {
      heart: { inserted: 0, updated: 0, unchanged: 0 },
      calories: { inserted: 0, updated: 0, unchanged: 0 },
    },
    finalizedDates: 0,
    validation: null,
  };
  const accounts = (await pool.query('SELECT id FROM source_accounts ORDER BY id')).rows;
  const accountDates = new Map();

  for (const { id: sourceAccountId } of accounts) {
    const dates = new Set();
    accountDates.set(sourceAccountId, dates);
    for (const metric of ['heart', 'calories']) {
      const identities = new Set();
      await scanLegacy(pool, sourceAccountId, metric, boundedBatchSize, async (records) => {
        for (const record of records) {
          const key = legacyMetrics[metric].semanticKey(record);
          if (identities.has(key)) {
            throw new Error(`Duplicate ${metric === 'heart' ? 'heart' : 'calorie'} semantic identity: ${key}`);
          }
          identities.add(key);
          dates.add(record.civilDate);
        }
        result.sourceRows[metric] += records.length;
      });
    }
  }

  if (!execute) return result;

  for (const { id: sourceAccountId } of accounts) {
    await scanLegacy(pool, sourceAccountId, 'heart', boundedBatchSize, async (records) => {
      addCounts(
        result.compactWrites.heart,
        await compactWriter.upsertHeartSamples(sourceAccountId, records),
      );
    });
    await scanLegacy(pool, sourceAccountId, 'calories', boundedBatchSize, async (records) => {
      addCounts(
        result.compactWrites.calories,
        await compactWriter.upsertCalorieIntervals(sourceAccountId, records),
      );
    });
    for (const date of [...accountDates.get(sourceAccountId)].sort()) {
      await metricWriter.recalculateDaily(sourceAccountId, date);
      result.finalizedDates += 1;
    }
  }
  result.validation = await validateCompactHealth(pool);
  return result;
}
