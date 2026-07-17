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
  assert.equal(Number(heartDaily.coverage_seconds), 600);
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
