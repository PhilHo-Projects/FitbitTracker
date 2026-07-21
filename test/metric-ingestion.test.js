import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import {
  normalizeCalorieIntervals,
  normalizeDailyRestingHeartRate,
  normalizeHeartRateSamples,
} from '../lib/metrics/normalizers.js';

async function createDatabase() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  await pool.query(
    `INSERT INTO source_accounts (
      id, provider, provider_account_id, timezone, membership_start_date
    ) VALUES (
      '75ce6554-70c7-48be-a688-d0079384fcb1', 'google-health', 'test', 'America/Toronto', '2026-01-01'
    )`,
  );
  return pool;
}

test('normalizers preserve civil dates across offset changes and measured zero calories', () => {
  const heart = normalizeHeartRateSamples({
    dataPoints: [
      {
        dataPointName: 'heart-point',
        heartRate: {
          samples: [
            { sampleTime: '2026-11-01T05:30:00Z', utcOffset: '-14400s', beatsPerMinute: 61 },
            { sampleTime: '2026-11-01T06:30:00Z', utcOffset: '-18000s', beatsPerMinute: 63 },
          ],
        },
      },
    ],
  });
  const calories = normalizeCalorieIntervals(
    {
      dataPoints: [
        {
          dataPointName: 'active-zero',
          activeEnergyBurned: {
            interval: {
              startTime: '2026-11-01T05:00:00Z',
              endTime: '2026-11-01T06:00:00Z',
              startUtcOffset: '-14400s',
            },
            kilocalories: 0,
          },
        },
      ],
    },
    'active',
  );

  assert.deepEqual(heart.map(({ civilDate }) => civilDate), ['2026-11-01', '2026-11-01']);
  assert.equal(calories.length, 1);
  assert.equal(calories[0].kilocalories, 0);
  assert.equal(calories[0].metricType, 'active');
});

test('normalizers accept the Google Health v4 data point representations', () => {
  const heart = normalizeHeartRateSamples({
    dataPoints: [
      {
        dataPointName: 'users/me/dataTypes/heart-rate/dataPoints/one',
        heartRate: {
          sampleTime: {
            physicalTime: '2026-07-16T12:00:00Z',
            utcOffset: '-14400s',
          },
          beatsPerMinute: '71',
        },
      },
    ],
  });
  const resting = normalizeDailyRestingHeartRate({
    dataPoints: [
      {
        dailyRestingHeartRate: {
          date: { year: 2026, month: 7, day: 16 },
          beatsPerMinute: '58',
        },
      },
    ],
  });
  const active = normalizeCalorieIntervals(
    {
      dataPoints: [
        {
          activeEnergyBurned: {
            interval: {
              startTime: '2026-07-16T12:00:00Z',
              endTime: '2026-07-16T13:00:00Z',
              startUtcOffset: '-14400s',
            },
            kcal: 20.5,
          },
        },
      ],
    },
    'active',
  );
  const total = normalizeCalorieIntervals(
    {
      rollupDataPoints: [
        {
          civilStartTime: { date: { year: 2026, month: 7, day: 16 } },
          civilEndTime: { date: { year: 2026, month: 7, day: 17 } },
          totalCalories: { kcalSum: 2448 },
        },
      ],
    },
    'total',
  );

  assert.equal(heart[0].sampledAt, '2026-07-16T12:00:00Z');
  assert.equal(heart[0].beatsPerMinute, 71);
  assert.equal(resting[0].civilDate, '2026-07-16');
  assert.equal(active[0].kilocalories, 20.5);
  assert.equal(total[0].kilocalories, 2448);
  assert.equal(total[0].civilDate, '2026-07-16');
});

test('metric upserts are idempotent, accept corrections, and preserve zero-versus-missing', async () => {
  const pool = await createDatabase();
  const writer = createMetricWriter(pool);
  const sourceAccountId = '75ce6554-70c7-48be-a688-d0079384fcb1';

  const original = normalizeHeartRateSamples({
    dataPoints: [
      {
        dataPointName: 'heart-point',
        heartRate: {
          samples: [
            { sampleTime: '2026-07-16T12:00:00Z', utcOffset: '-14400s', beatsPerMinute: 70 },
            { sampleTime: '2026-07-16T12:05:00Z', utcOffset: '-14400s', beatsPerMinute: 72 },
          ],
        },
      },
    ],
  });
  const corrected = [{ ...original[0], beatsPerMinute: 82 }];
  await writer.upsertHeartSamples(sourceAccountId, original);
  await writer.upsertHeartSamples(sourceAccountId, corrected);

  await writer.upsertCalorieIntervals(sourceAccountId, [
    {
      providerKey: 'active-zero',
      civilDate: '2026-07-16',
      metricType: 'active',
      startTime: '2026-07-16T12:00:00Z',
      endTime: '2026-07-16T13:00:00Z',
      utcOffsetSeconds: -14400,
      kilocalories: 0,
      sourceFields: {},
    },
    {
      providerKey: 'basal-70',
      civilDate: '2026-07-16',
      metricType: 'basal',
      startTime: '2026-07-16T12:00:00Z',
      endTime: '2026-07-16T13:00:00Z',
      utcOffsetSeconds: -14400,
      kilocalories: 70,
      sourceFields: {},
    },
  ]);
  await writer.recalculateDaily(sourceAccountId, '2026-07-16');

  const heartRows = await pool.query(
    'SELECT beats_per_minute FROM heart_rate_samples ORDER BY sampled_at',
  );
  const heartDaily = (await pool.query('SELECT * FROM heart_rate_daily_summaries')).rows[0];
  const calories = (await pool.query('SELECT * FROM calorie_daily_summaries')).rows[0];
  const daily = (await pool.query('SELECT coverage FROM daily_health_summaries')).rows[0];

  assert.deepEqual(heartRows.rows.map(({ beats_per_minute: bpm }) => Number(bpm)), [82, 72]);
  assert.equal(Number(heartDaily.sample_count), 2);
  assert.equal(Number(heartDaily.average_bpm), 77);
  assert.equal(Number(heartDaily.minimum_bpm), 72);
  assert.equal(Number(heartDaily.maximum_bpm), 82);
  assert.equal(Number(heartDaily.coverage_seconds), 600);
  assert.equal(Number(heartDaily.bpm_sum), 154);
  assert.equal(Number(heartDaily.bpm_sum_of_squares), 11908);
  assert.equal(Number(heartDaily.population_standard_deviation_bpm), 5);
  assert.equal(Number(heartDaily.p05_bpm), 72.5);
  assert.equal(Number(heartDaily.median_bpm), 77);
  assert.equal(Number(heartDaily.p95_bpm), 81.5);
  assert.equal(Number(heartDaily.aggregation_version), 2);
  assert.ok(heartDaily.finalized_at);
  assert.equal(Number(calories.active_kcal), 0);
  assert.equal(Number(calories.basal_kcal), 70);
  assert.equal(Number(calories.total_kcal), 70);
  assert.equal(Number(calories.coverage_seconds), 3600);
  assert.equal(calories.total_derived, true);
  assert.deepEqual(daily.coverage, {
    sleep: 'missing',
    heart: 'partial',
    calories: 'partial',
  });

  await pool.end();
});

test('raw pruning refuses unarchived rows and removes only verified archive months', async () => {
  const pool = await createDatabase();
  const writer = createMetricWriter(pool);
  const sourceAccountId = '75ce6554-70c7-48be-a688-d0079384fcb1';

  for (const civilDate of ['2026-01-01', '2026-04-01', '2026-04-18', '2026-07-16']) {
    await writer.upsertHeartSamples(sourceAccountId, [
      {
        providerKey: `heart-${civilDate}`,
        civilDate,
        sampledAt: `${civilDate}T12:00:00Z`,
        utcOffsetSeconds: -18000,
        beatsPerMinute: 70,
        sourceFields: {},
      },
    ]);
    await writer.upsertCalorieIntervals(sourceAccountId, [
      {
        providerKey: `active-${civilDate}`,
        civilDate,
        metricType: 'active',
        startTime: `${civilDate}T12:00:00Z`,
        endTime: `${civilDate}T13:00:00Z`,
        utcOffsetSeconds: -18000,
        kilocalories: 20,
        sourceFields: {},
      },
    ]);
    await writer.recalculateDaily(sourceAccountId, civilDate);
  }
  await pool.query(
    `INSERT INTO sleep_sessions (
      id, source_account_id, provider_key, civil_date, start_time, end_time,
      duration_seconds, sleep_type, is_nap
    ) VALUES (
      'c754ab9b-0a67-4edb-bb36-62f973b36036', $1, 'old-sleep', '2026-01-01',
      '2026-01-01T03:00:00Z', '2026-01-01T11:00:00Z', 28800,
      'stages', false
    )`,
    [sourceAccountId],
  );

  assert.deepEqual(await writer.pruneRawMetricsBefore(sourceAccountId, '2026-04-19'), {
    heartRateSamples: 0,
    calorieIntervals: 0,
  });
  await pool.query(
    `INSERT INTO health_archive_catalog (
      id, source_account_id, archive_month, archive_version, is_active, state,
      heart_sample_count, calorie_interval_count, verified_at
    ) VALUES
      (
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $1, '2026-01-01', 1, true, 'verified',
        1, 1, CURRENT_TIMESTAMP
      ),
      (
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $1, '2026-04-01', 1, true, 'verified',
        2, 2, CURRENT_TIMESTAMP
      )`,
    [sourceAccountId],
  );
  const removed = await writer.pruneRawMetricsBefore(sourceAccountId, '2026-04-19');
  await writer.recalculateDaily(sourceAccountId, '2026-01-01');
  const counts = {};
  for (const table of [
    'heart_rate_samples',
    'calorie_intervals',
    'heart_rate_daily_summaries',
    'calorie_daily_summaries',
    'sleep_sessions',
  ]) {
    counts[table] = Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
  }

  assert.deepEqual(removed, { heartRateSamples: 1, calorieIntervals: 1 });
  const retainedHeart = (
    await pool.query(
      `SELECT average_bpm, sample_count FROM heart_rate_daily_summaries
       WHERE source_account_id = $1 AND civil_date = '2026-01-01'`,
      [sourceAccountId],
    )
  ).rows[0];
  assert.equal(Number(retainedHeart.average_bpm), 70);
  assert.equal(Number(retainedHeart.sample_count), 1);
  assert.deepEqual(counts, {
    heart_rate_samples: 3,
    calorie_intervals: 3,
    heart_rate_daily_summaries: 4,
    calorie_daily_summaries: 4,
    sleep_sessions: 1,
  });
  await pool.end();
});
