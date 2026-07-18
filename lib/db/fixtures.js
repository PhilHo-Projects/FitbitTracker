import { deterministicUuid } from './ids.js';

const ACCOUNT_ID = '75ce6554-70c7-48be-a688-d0079384fcb1';
const STAGE_PATTERN = [
  ['awake', 8],
  ['light', 40],
  ['deep', 35],
  ['light', 45],
  ['rem', 30],
  ['light', 50],
  ['deep', 45],
  ['rem', 25],
  ['light', 46],
  ['rem', 23],
  ['light', 40],
  ['awake', 10],
];

function dateOffset(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function isoAt(date, hour, minute = 0) {
  return new Date(`${date}T00:00:00Z`).getTime() + (hour * 60 + minute) * 60_000;
}

export async function seedFixtures(pool, { anchorDate = '2026-07-16' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO source_accounts (
        id, provider, provider_account_id, display_name, timezone, membership_start_date, profile
      ) VALUES ($1, 'google-health', 'fixture-account', 'Local fixture profile',
        'America/Toronto', '2024-01-01', $2)
      ON CONFLICT (provider, provider_account_id) DO UPDATE SET
        timezone = EXCLUDED.timezone,
        membership_start_date = EXCLUDED.membership_start_date,
        profile = EXCLUDED.profile,
        updated_at = CURRENT_TIMESTAMP`,
      [ACCOUNT_ID, { fixture: true, membershipStartDate: '2024-01-01' }],
    );

    for (let dayIndex = 0; dayIndex < 8; dayIndex += 1) {
      const civilDate = dateOffset(anchorDate, -dayIndex);
      const variance = dayIndex * 3;
      const durationSeconds = (397 - variance) * 60;
      const sessionId = deterministicUuid('fixture-sleep', civilDate);
      const startMs = isoAt(civilDate, 3, 17 + dayIndex);
      const endMs = startMs + durationSeconds * 1000;
      const awakeSeconds = 18 * 60;
      const asleepSeconds = durationSeconds - awakeSeconds;
      const efficiency = Math.round((asleepSeconds / durationSeconds) * 10_000) / 100;

      await client.query(
        `INSERT INTO sleep_sessions (
          id, source_account_id, provider_key, provider_id, civil_date, start_time, end_time,
          start_offset_seconds, end_offset_seconds, sleep_type, is_nap, duration_seconds,
          asleep_seconds, awake_seconds, efficiency, time_to_sleep_seconds, awake_episodes,
          device, source_fields
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, -14400, -14400, 'stages', false, $8,
          $9, $10, $11, 960, 2, $12, $13)
        ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
          end_time = EXCLUDED.end_time,
          duration_seconds = EXCLUDED.duration_seconds,
          asleep_seconds = EXCLUDED.asleep_seconds,
          awake_seconds = EXCLUDED.awake_seconds,
          efficiency = EXCLUDED.efficiency,
          source_fields = EXCLUDED.source_fields,
          updated_at = CURRENT_TIMESTAMP`,
        [
          sessionId,
          ACCOUNT_ID,
          `fixture-sleep-${civilDate}`,
          `sleep-${civilDate}`,
          civilDate,
          new Date(startMs),
          new Date(endMs),
          durationSeconds,
          asleepSeconds,
          awakeSeconds,
          efficiency,
          { manufacturer: 'Fixture', model: 'Deterministic Watch' },
          { fixture: true },
        ],
      );

      let stageStart = startMs;
      for (const [sequence, [stageType, minutes]] of STAGE_PATTERN.entries()) {
        const stageEnd = stageStart + minutes * 60_000;
        const providerKey = `${civilDate}-${sequence}-${stageType}`;
        await client.query(
          `INSERT INTO sleep_stages (
            id, sleep_session_id, provider_key, sequence, stage_type, start_time, end_time,
            duration_seconds, source_fields
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (sleep_session_id, provider_key) DO UPDATE SET
            stage_type = EXCLUDED.stage_type,
            start_time = EXCLUDED.start_time,
            end_time = EXCLUDED.end_time,
            duration_seconds = EXCLUDED.duration_seconds,
            source_fields = EXCLUDED.source_fields`,
          [
            deterministicUuid('fixture-stage', `${civilDate}:${providerKey}`),
            sessionId,
            providerKey,
            sequence,
            stageType,
            new Date(stageStart),
            new Date(stageEnd),
            minutes * 60,
            { fixture: true },
          ],
        );
        stageStart = stageEnd;
      }

      const restingBpm = 58 + dayIndex;
      const averageBpm = 74 + dayIndex;
      const minimumBpm = 49 + dayIndex;
      const maximumBpm = 142 - dayIndex;
      for (let sampleIndex = 0; sampleIndex < 48; sampleIndex += 1) {
        const sampledAt = new Date(isoAt(civilDate, 0) + sampleIndex * 30 * 60_000);
        const bpm = Math.round(
          averageBpm + Math.sin((sampleIndex / 48) * Math.PI * 4) * 12 + (sampleIndex % 11 === 0 ? 28 : 0),
        );
        const providerKey = `${civilDate}-${sampleIndex}`;
        await client.query(
          `INSERT INTO heart_rate_samples (
            id, source_account_id, provider_key, provider_id, civil_date, sampled_at,
            utc_offset_seconds, beats_per_minute, device, source_fields
          ) VALUES ($1, $2, $3, $4, $5, $6, -14400, $7, $8, $9)
          ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
            beats_per_minute = EXCLUDED.beats_per_minute,
            source_fields = EXCLUDED.source_fields,
            updated_at = CURRENT_TIMESTAMP`,
          [
            deterministicUuid('fixture-heart', providerKey),
            ACCOUNT_ID,
            `fixture-heart-${providerKey}`,
            `heart-${providerKey}`,
            civilDate,
            sampledAt,
            bpm,
            { manufacturer: 'Fixture', model: 'Deterministic Watch' },
            { fixture: true },
          ],
        );
      }

      await client.query(
        `INSERT INTO heart_rate_daily_summaries (
          id, source_account_id, civil_date, resting_bpm, average_bpm, minimum_bpm,
          maximum_bpm, sample_count, coverage_seconds, resting_derived, source_fields
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 48, 86400, false, $8)
        ON CONFLICT (source_account_id, civil_date) DO UPDATE SET
          resting_bpm = EXCLUDED.resting_bpm,
          average_bpm = EXCLUDED.average_bpm,
          minimum_bpm = EXCLUDED.minimum_bpm,
          maximum_bpm = EXCLUDED.maximum_bpm,
          sample_count = EXCLUDED.sample_count,
          coverage_seconds = EXCLUDED.coverage_seconds,
          source_fields = EXCLUDED.source_fields,
          updated_at = CURRENT_TIMESTAMP`,
        [
          deterministicUuid('fixture-heart-daily', civilDate),
          ACCOUNT_ID,
          civilDate,
          restingBpm,
          averageBpm,
          minimumBpm,
          maximumBpm,
          { fixture: true },
        ],
      );

      const activeKcal = 708 - dayIndex * 22;
      const basalKcal = 1740 + dayIndex * 2;
      const totalKcal = activeKcal + basalKcal;
      for (let intervalIndex = 0; intervalIndex < 24; intervalIndex += 1) {
        for (const [metricType, dailyValue] of [
          ['active', activeKcal],
          ['basal', basalKcal],
        ]) {
          const startTime = new Date(isoAt(civilDate, intervalIndex));
          const endTime = new Date(startTime.getTime() + 60 * 60_000);
          const providerKey = `${civilDate}-${metricType}-${intervalIndex}`;
          await client.query(
            `INSERT INTO calorie_intervals (
              id, source_account_id, provider_key, provider_id, civil_date, metric_type,
              start_time, end_time, utc_offset_seconds, kilocalories, device, source_fields
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, -14400, $9, $10, $11)
            ON CONFLICT (source_account_id, provider_key) DO UPDATE SET
              kilocalories = EXCLUDED.kilocalories,
              source_fields = EXCLUDED.source_fields,
              updated_at = CURRENT_TIMESTAMP`,
            [
              deterministicUuid('fixture-calorie', providerKey),
              ACCOUNT_ID,
              `fixture-calorie-${providerKey}`,
              `calorie-${providerKey}`,
              civilDate,
              metricType,
              startTime,
              endTime,
              dailyValue / 24,
              { manufacturer: 'Fixture', model: 'Deterministic Watch' },
              { fixture: true },
            ],
          );
        }
      }

      await client.query(
        `INSERT INTO calorie_daily_summaries (
          id, source_account_id, civil_date, total_kcal, active_kcal, basal_kcal,
          interval_count, coverage_seconds, total_derived, source_fields
        ) VALUES ($1, $2, $3, $4, $5, $6, 48, 86400, true, $7)
        ON CONFLICT (source_account_id, civil_date) DO UPDATE SET
          total_kcal = EXCLUDED.total_kcal,
          active_kcal = EXCLUDED.active_kcal,
          basal_kcal = EXCLUDED.basal_kcal,
          interval_count = EXCLUDED.interval_count,
          coverage_seconds = EXCLUDED.coverage_seconds,
          total_derived = EXCLUDED.total_derived,
          source_fields = EXCLUDED.source_fields,
          updated_at = CURRENT_TIMESTAMP`,
        [
          deterministicUuid('fixture-calorie-daily', civilDate),
          ACCOUNT_ID,
          civilDate,
          totalKcal,
          activeKcal,
          basalKcal,
          { fixture: true },
        ],
      );

      await client.query(
        `INSERT INTO daily_health_summaries (
          id, source_account_id, civil_date, sleep_session_id, sleep_duration_seconds,
          sleep_asleep_seconds, sleep_awake_seconds, sleep_efficiency, heart_resting_bpm,
          heart_average_bpm, heart_minimum_bpm, heart_maximum_bpm, heart_sample_count,
          calorie_total_kcal, calorie_active_kcal, calorie_basal_kcal, coverage, derivations
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 48, $13, $14, $15, $16, $17)
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
          deterministicUuid('fixture-daily', civilDate),
          ACCOUNT_ID,
          civilDate,
          sessionId,
          durationSeconds,
          asleepSeconds,
          awakeSeconds,
          efficiency,
          restingBpm,
          averageBpm,
          minimumBpm,
          maximumBpm,
          totalKcal,
          activeKcal,
          basalKcal,
          { sleep: 'complete', heart: 'complete', calories: 'complete' },
          { calorieTotal: true, heartResting: false },
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

  return { sourceAccountId: ACCOUNT_ID, anchorDate };
}
