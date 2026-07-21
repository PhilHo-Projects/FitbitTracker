import { deterministicUuid } from './ids.js';
import { createCompactMetricWriter } from './compact-metric-writer.js';

function numeric(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function heartCoverageSeconds(samples) {
  const buckets = new Set();
  for (const sample of samples) {
    const timestamp = new Date(sample.sampled_at).getTime();
    if (Number.isFinite(timestamp)) buckets.add(Math.floor(timestamp / 300_000));
  }
  return Math.min(86_400, buckets.size * 300);
}

function intervalCoverageSeconds(rows) {
  const intervals = rows
    .map((row) => [new Date(row.start_time).getTime(), new Date(row.end_time).getTime()])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort(([left], [right]) => left - right);
  let coverageMs = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const [start, end] of intervals) {
    if (currentStart === null) {
      currentStart = start;
      currentEnd = end;
    } else if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      coverageMs += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  if (currentStart !== null) coverageMs += currentEnd - currentStart;
  return Math.min(86_400, Math.round(coverageMs / 1000));
}

function coverageState(row) {
  if (!row) return 'missing';
  return Number(row.coverage_seconds || 0) >= 20 * 60 * 60 ? 'complete' : 'partial';
}

function offsetSeconds(value) {
  const text = String(value ?? '').trim();
  const parsed = Number(text.endsWith('s') ? text.slice(0, -1) : text);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentileCont(sortedValues, percentile) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

async function acquireDatabase(database, clientOwnedByCaller) {
  if (!clientOwnedByCaller) return database.connect();
  return {
    query: database.query.bind(database),
    release() {},
  };
}

export function createMetricWriter(
  pool,
  {
    compactWritesEnabled = false,
    compactWriter = createCompactMetricWriter(pool),
    clientOwnedByCaller = false,
  } = {},
) {
  return {
    async upsertSleepSessions(sourceAccountId, sessions) {
      const client = await acquireDatabase(pool, clientOwnedByCaller);
      try {
        await client.query('BEGIN');
        for (const session of sessions) {
          const providerKey = session.id;
          const sessionId = deterministicUuid('sleep-session', `${sourceAccountId}:${providerKey}`);
          await client.query(
            `INSERT INTO sleep_sessions (
              id, source_account_id, provider_key, provider_id, civil_date, start_time, end_time,
              start_offset_seconds, end_offset_seconds, sleep_type, is_nap, duration_seconds,
              asleep_seconds, awake_seconds, efficiency, time_to_sleep_seconds, awake_episodes,
              device, source_fields
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
            )
            ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
              provider_id = EXCLUDED.provider_id,
              civil_date = EXCLUDED.civil_date,
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time,
              start_offset_seconds = EXCLUDED.start_offset_seconds,
              end_offset_seconds = EXCLUDED.end_offset_seconds,
              sleep_type = EXCLUDED.sleep_type,
              is_nap = EXCLUDED.is_nap,
              duration_seconds = EXCLUDED.duration_seconds,
              asleep_seconds = EXCLUDED.asleep_seconds,
              awake_seconds = EXCLUDED.awake_seconds,
              efficiency = EXCLUDED.efficiency,
              time_to_sleep_seconds = EXCLUDED.time_to_sleep_seconds,
              awake_episodes = EXCLUDED.awake_episodes,
              device = EXCLUDED.device,
              source_fields = EXCLUDED.source_fields,
              updated_at = CURRENT_TIMESTAMP`,
            [
              sessionId,
              sourceAccountId,
              providerKey,
              session.metadata?.externalId ?? session.id,
              session.date,
              session.startTime,
              session.endTime,
              offsetSeconds(session.startUtcOffset),
              offsetSeconds(session.endUtcOffset),
              session.type,
              Boolean(session.isNap),
              Math.round(Number(session.durationMinutes || 0) * 60),
              Math.round(Number(session.minutesAsleep || 0) * 60),
              Math.round(Number(session.minutesAwake || 0) * 60),
              session.efficiency ?? null,
              Math.round(Number(session.minutesToFallAsleep || 0) * 60),
              Number(session.stageSummary?.awake?.count || 0),
              session.source?.device ?? {},
              session,
            ],
          );
          await client.query('DELETE FROM sleep_stages WHERE sleep_session_id = $1', [sessionId]);
          for (const [sequence, stage] of (session.stages ?? []).entries()) {
            const stageKey = `${sequence}:${stage.type}:${stage.startTime}`;
            await client.query(
              `INSERT INTO sleep_stages (
                id, sleep_session_id, provider_key, sequence, stage_type, start_time, end_time,
                duration_seconds, source_fields
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                deterministicUuid('sleep-stage', `${sessionId}:${stageKey}`),
                sessionId,
                stageKey,
                sequence,
                stage.type,
                stage.startTime,
                stage.endTime,
                Math.round(Number(stage.durationMinutes || 0) * 60),
                stage,
              ],
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async upsertRestingHeartRateDaily(sourceAccountId, summaries) {
      for (const summary of summaries) {
        await pool.query(
          `INSERT INTO heart_rate_daily_summaries (
            id, source_account_id, civil_date, resting_bpm, sample_count,
            coverage_seconds, resting_derived, source_fields
          ) VALUES ($1, $2, $3, $4, 0, 0, false, $5)
          ON CONFLICT (source_account_id, civil_date) DO UPDATE SET
            resting_bpm = EXCLUDED.resting_bpm,
            resting_derived = false,
            source_fields = EXCLUDED.source_fields,
            updated_at = CURRENT_TIMESTAMP`,
          [
            deterministicUuid('heart-daily', `${sourceAccountId}:${summary.civilDate}`),
            sourceAccountId,
            summary.civilDate,
            summary.restingBpm,
            summary.sourceFields ?? {},
          ],
        );
      }
    },

    async upsertHeartSamples(sourceAccountId, samples) {
      const client = await acquireDatabase(pool, clientOwnedByCaller);
      try {
        await client.query('BEGIN');
        for (const sample of samples) {
          await client.query(
            `INSERT INTO heart_rate_samples (
              id, source_account_id, provider_key, provider_id, civil_date, sampled_at,
              utc_offset_seconds, beats_per_minute, device, source_fields
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
              provider_id = EXCLUDED.provider_id,
              civil_date = EXCLUDED.civil_date,
              sampled_at = EXCLUDED.sampled_at,
              utc_offset_seconds = EXCLUDED.utc_offset_seconds,
              beats_per_minute = EXCLUDED.beats_per_minute,
              device = EXCLUDED.device,
              source_fields = EXCLUDED.source_fields,
              updated_at = CURRENT_TIMESTAMP`,
            [
              deterministicUuid('heart-rate-sample', `${sourceAccountId}:${sample.providerKey}`),
              sourceAccountId,
              sample.providerKey,
              sample.providerId ?? null,
              sample.civilDate,
              sample.sampledAt,
              sample.utcOffsetSeconds ?? null,
              sample.beatsPerMinute,
              sample.device ?? {},
              sample.sourceFields ?? {},
            ],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (!compactWritesEnabled) {
        return { inserted: 0, updated: 0, unchanged: 0, skipped: samples.length };
      }
      return compactWriter.upsertHeartSamples(sourceAccountId, samples);
    },

    async upsertCalorieIntervals(sourceAccountId, intervals) {
      const client = await acquireDatabase(pool, clientOwnedByCaller);
      try {
        await client.query('BEGIN');
        for (const interval of intervals) {
          await client.query(
            `INSERT INTO calorie_intervals (
              id, source_account_id, provider_key, provider_id, civil_date, metric_type,
              start_time, end_time, utc_offset_seconds, kilocalories, device, source_fields
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
              provider_id = EXCLUDED.provider_id,
              civil_date = EXCLUDED.civil_date,
              metric_type = EXCLUDED.metric_type,
              start_time = EXCLUDED.start_time,
              end_time = EXCLUDED.end_time,
              utc_offset_seconds = EXCLUDED.utc_offset_seconds,
              kilocalories = EXCLUDED.kilocalories,
              device = EXCLUDED.device,
              source_fields = EXCLUDED.source_fields,
              updated_at = CURRENT_TIMESTAMP`,
            [
              deterministicUuid('calorie-interval', `${sourceAccountId}:${interval.providerKey}`),
              sourceAccountId,
              interval.providerKey,
              interval.providerId ?? null,
              interval.civilDate,
              interval.metricType,
              interval.startTime,
              interval.endTime,
              interval.utcOffsetSeconds ?? null,
              interval.kilocalories,
              interval.device ?? {},
              interval.sourceFields ?? {},
            ],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (!compactWritesEnabled) {
        return { inserted: 0, updated: 0, unchanged: 0, skipped: intervals.length };
      }
      return compactWriter.upsertCalorieIntervals(sourceAccountId, intervals);
    },

    async pruneRawMetricsBefore(sourceAccountId, cutoffDate) {
      const client = await acquireDatabase(pool, clientOwnedByCaller);
      try {
        await client.query('BEGIN');
        const heart = await client.query(
          `DELETE FROM heart_rate_samples
           WHERE id IN (
             SELECT raw.id
             FROM heart_rate_samples AS raw
             JOIN health_archive_catalog AS archive
               ON archive.source_account_id = raw.source_account_id
              AND archive.is_active = true
              AND archive.state = 'verified'
              AND archive.verified_at IS NOT NULL
              AND archive.archive_month + INTERVAL '1 month' <= $2::date
              AND raw.civil_date >= archive.archive_month
              AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
             WHERE raw.source_account_id = $1 AND raw.civil_date < $2
           )`,
          [sourceAccountId, cutoffDate],
        );
        const calories = await client.query(
          `DELETE FROM calorie_intervals
           WHERE id IN (
             SELECT raw.id
             FROM calorie_intervals AS raw
             JOIN health_archive_catalog AS archive
               ON archive.source_account_id = raw.source_account_id
              AND archive.is_active = true
              AND archive.state = 'verified'
              AND archive.verified_at IS NOT NULL
              AND archive.archive_month + INTERVAL '1 month' <= $2::date
              AND raw.civil_date >= archive.archive_month
              AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
             WHERE raw.source_account_id = $1 AND raw.civil_date < $2
           )`,
          [sourceAccountId, cutoffDate],
        );
        await client.query('COMMIT');
        return {
          heartRateSamples: heart.rowCount,
          calorieIntervals: calories.rowCount,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async recalculateDaily(sourceAccountId, civilDate, database = pool) {
      const heartSamples = (
        await database.query(
          `SELECT sampled_at, beats_per_minute
           FROM heart_rate_samples
           WHERE source_account_id = $1 AND civil_date = $2
           ORDER BY sampled_at`,
          [sourceAccountId, civilDate],
        )
      ).rows;
      const heartValues = heartSamples.map(({ beats_per_minute: value }) => numeric(value));
      const existingHeart = (
        await database.query(
          `SELECT resting_bpm, resting_derived, source_fields
           FROM heart_rate_daily_summaries
           WHERE source_account_id = $1 AND civil_date = $2`,
          [sourceAccountId, civilDate],
        )
      ).rows[0];
      const heartCount = heartValues.length;
      if (heartCount) {
        const sortedHeartValues = [...heartValues].sort((left, right) => left - right);
        const bpmSum = heartValues.reduce((sum, value) => sum + value, 0);
        const bpmSumOfSquares = heartValues.reduce((sum, value) => sum + value ** 2, 0);
        const averageBpm = bpmSum / heartCount;
        const populationStandardDeviationBpm = Math.sqrt(
          Math.max(0, bpmSumOfSquares / heartCount - averageBpm ** 2),
        );
        await database.query(
          `INSERT INTO heart_rate_daily_summaries (
            id, source_account_id, civil_date, resting_bpm, average_bpm, minimum_bpm,
            maximum_bpm, sample_count, coverage_seconds, resting_derived, source_fields,
            bpm_sum, bpm_sum_of_squares, population_standard_deviation_bpm,
            p05_bpm, median_bpm, p95_bpm, aggregation_version, finalized_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, $17, $18, CURRENT_TIMESTAMP
          )
          ON CONFLICT (source_account_id, civil_date) DO UPDATE SET
            average_bpm = EXCLUDED.average_bpm,
            minimum_bpm = EXCLUDED.minimum_bpm,
            maximum_bpm = EXCLUDED.maximum_bpm,
            sample_count = EXCLUDED.sample_count,
            coverage_seconds = EXCLUDED.coverage_seconds,
            bpm_sum = EXCLUDED.bpm_sum,
            bpm_sum_of_squares = EXCLUDED.bpm_sum_of_squares,
            population_standard_deviation_bpm = EXCLUDED.population_standard_deviation_bpm,
            p05_bpm = EXCLUDED.p05_bpm,
            median_bpm = EXCLUDED.median_bpm,
            p95_bpm = EXCLUDED.p95_bpm,
            aggregation_version = EXCLUDED.aggregation_version,
            finalized_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP`,
          [
            deterministicUuid('heart-daily', `${sourceAccountId}:${civilDate}`),
            sourceAccountId,
            civilDate,
            numeric(existingHeart?.resting_bpm),
            averageBpm,
            sortedHeartValues[0],
            sortedHeartValues.at(-1),
            heartCount,
            heartCoverageSeconds(heartSamples),
            Boolean(existingHeart?.resting_derived),
            existingHeart?.source_fields ?? {},
            bpmSum,
            bpmSumOfSquares,
            populationStandardDeviationBpm,
            percentileCont(sortedHeartValues, 0.05),
            percentileCont(sortedHeartValues, 0.5),
            percentileCont(sortedHeartValues, 0.95),
            2,
          ],
        );
      }

      const calorieRows = (
        await database.query(
          `SELECT metric_type, kilocalories, start_time, end_time
           FROM calorie_intervals
           WHERE source_account_id = $1 AND civil_date = $2`,
          [sourceAccountId, civilDate],
        )
      ).rows;
      const calorie = { total: null, active: null, basal: null };
      for (const row of calorieRows) {
        calorie[row.metric_type] ??= 0;
        calorie[row.metric_type] += numeric(row.kilocalories) ?? 0;
      }
      if (calorieRows.length) {
        const derivedTotal = calorie.total === null;
        const total = derivedTotal
          ? (calorie.active ?? 0) + (calorie.basal ?? 0)
          : calorie.total;
        await database.query(
          `INSERT INTO calorie_daily_summaries (
            id, source_account_id, civil_date, total_kcal, active_kcal, basal_kcal,
            interval_count, coverage_seconds, total_derived, source_fields
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (source_account_id, civil_date) DO UPDATE SET
            total_kcal = EXCLUDED.total_kcal,
            active_kcal = EXCLUDED.active_kcal,
            basal_kcal = EXCLUDED.basal_kcal,
            interval_count = EXCLUDED.interval_count,
            coverage_seconds = EXCLUDED.coverage_seconds,
            total_derived = EXCLUDED.total_derived,
            updated_at = CURRENT_TIMESTAMP`,
          [
            deterministicUuid('calorie-daily', `${sourceAccountId}:${civilDate}`),
            sourceAccountId,
            civilDate,
            total,
            calorie.active,
            calorie.basal,
            calorieRows.length,
            intervalCoverageSeconds(calorieRows),
            derivedTotal,
            {},
          ],
        );
      }

      const sleep = await database.query(
        `SELECT * FROM sleep_sessions
         WHERE source_account_id = $1 AND civil_date = $2 AND is_nap = false
         ORDER BY duration_seconds DESC LIMIT 1`,
        [sourceAccountId, civilDate],
      );
      const heart = await database.query(
        `SELECT * FROM heart_rate_daily_summaries
         WHERE source_account_id = $1 AND civil_date = $2`,
        [sourceAccountId, civilDate],
      );
      const calories = await database.query(
        `SELECT * FROM calorie_daily_summaries
         WHERE source_account_id = $1 AND civil_date = $2`,
        [sourceAccountId, civilDate],
      );
      const sleepRow = sleep.rows[0];
      const heartRow = heart.rows[0];
      const calorieRow = calories.rows[0];
      const coverage = {
        sleep: sleepRow ? 'complete' : 'missing',
        heart: coverageState(heartRow),
        calories: coverageState(calorieRow),
      };
      await database.query(
        `INSERT INTO daily_health_summaries (
          id, source_account_id, civil_date, sleep_session_id, sleep_duration_seconds,
          sleep_asleep_seconds, sleep_awake_seconds, sleep_efficiency, heart_resting_bpm,
          heart_average_bpm, heart_minimum_bpm, heart_maximum_bpm, heart_sample_count,
          calorie_total_kcal, calorie_active_kcal, calorie_basal_kcal, coverage, derivations
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        )
        ON CONFLICT (source_account_id, civil_date) DO UPDATE SET
          sleep_session_id = EXCLUDED.sleep_session_id,
          sleep_duration_seconds = EXCLUDED.sleep_duration_seconds,
          sleep_asleep_seconds = EXCLUDED.sleep_asleep_seconds,
          sleep_awake_seconds = EXCLUDED.sleep_awake_seconds,
          sleep_efficiency = EXCLUDED.sleep_efficiency,
          heart_resting_bpm = EXCLUDED.heart_resting_bpm,
          heart_average_bpm = EXCLUDED.heart_average_bpm,
          heart_minimum_bpm = EXCLUDED.heart_minimum_bpm,
          heart_maximum_bpm = EXCLUDED.heart_maximum_bpm,
          heart_sample_count = EXCLUDED.heart_sample_count,
          calorie_total_kcal = EXCLUDED.calorie_total_kcal,
          calorie_active_kcal = EXCLUDED.calorie_active_kcal,
          calorie_basal_kcal = EXCLUDED.calorie_basal_kcal,
          coverage = EXCLUDED.coverage,
          derivations = EXCLUDED.derivations,
          updated_at = CURRENT_TIMESTAMP`,
        [
          deterministicUuid('daily-health', `${sourceAccountId}:${civilDate}`),
          sourceAccountId,
          civilDate,
          sleepRow?.id ?? null,
          sleepRow?.duration_seconds ?? null,
          sleepRow?.asleep_seconds ?? null,
          sleepRow?.awake_seconds ?? null,
          sleepRow?.efficiency ?? null,
          heartRow?.resting_bpm ?? null,
          heartRow?.average_bpm ?? null,
          heartRow?.minimum_bpm ?? null,
          heartRow?.maximum_bpm ?? null,
          heartRow?.sample_count ?? null,
          calorieRow?.total_kcal ?? null,
          calorieRow?.active_kcal ?? null,
          calorieRow?.basal_kcal ?? null,
          coverage,
          {
            heartResting: Boolean(heartRow?.resting_derived),
            calorieTotal: Boolean(calorieRow?.total_derived),
          },
        ],
      );
    },
  };
}
