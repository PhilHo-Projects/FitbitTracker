import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';
import { seedFixtures } from '../lib/db/fixtures.js';
import { createHealthRepository } from '../lib/db/health-repository.js';

async function createFixtureDatabase() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  return pool;
}

test('deterministic fixtures seed raw and summary data idempotently', async () => {
  const pool = await createFixtureDatabase();

  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  await seedFixtures(pool, { anchorDate: '2026-07-16' });

  const counts = {};
  for (const table of [
    'source_accounts',
    'sleep_sessions',
    'sleep_stages',
    'heart_rate_samples',
    'heart_rate_daily_summaries',
    'calorie_intervals',
    'calorie_daily_summaries',
    'daily_health_summaries',
  ]) {
    counts[table] = Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
  }

  assert.deepEqual(counts, {
    source_accounts: 1,
    sleep_sessions: 8,
    sleep_stages: 96,
    heart_rate_samples: 384,
    heart_rate_daily_summaries: 8,
    calorie_intervals: 384,
    calorie_daily_summaries: 8,
    daily_health_summaries: 8,
  });

  await pool.end();
});

test('dashboard query distinguishes present metrics from missing coverage', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const repository = createHealthRepository(pool);

  const dashboard = await repository.getDashboard('2026-07-16');
  const missing = await repository.getDashboard('2026-06-01');

  assert.equal(dashboard.date, '2026-07-16');
  assert.equal(dashboard.timezone, 'America/Toronto');
  assert.equal(dashboard.sleep.durationMinutes, 397);
  assert.equal(dashboard.sleep.stageSummary.light.minutes, 221);
  assert.equal(dashboard.sleep.stages.length, 12);
  assert.deepEqual(dashboard.heart, {
    restingBpm: 58,
    averageBpm: 74,
    minimumBpm: 49,
    maximumBpm: 142,
    sampleCount: 48,
    coverageSeconds: 86400,
    bpmSum: null,
    bpmSumOfSquares: null,
    populationStandardDeviationBpm: null,
    percentilesBpm: { p05: null, median: null, p95: null },
    aggregationVersion: 1,
    finalizedAt: null,
    missing: false,
    derived: { resting: false },
  });
  assert.equal(dashboard.calories.totalKcal, 2448);
  assert.equal(dashboard.calories.activeKcal, 708);
  assert.equal(dashboard.calories.basalKcal, 1740);
  assert.equal(dashboard.coverage.sleep, 'complete');
  assert.equal(missing.sleep, null);
  assert.equal(missing.heart.missing, true);
  assert.equal(missing.calories.missing, true);

  await pool.end();
});

test('metric workspaces expose closed-open ranges at day and detail resolutions', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const repository = createHealthRepository(pool);

  const sleep = await repository.getSleepRange('2026-07-15', '2026-07-17');
  const heartDay = await repository.getHeartRange('2026-07-16', '2026-07-17', 'five-minute');
  const heartRange = await repository.getHeartRange('2026-07-09', '2026-07-17', 'day');
  const calorieDay = await repository.getCaloriesRange('2026-07-16', '2026-07-17', 'hour');
  const calorieRange = await repository.getCaloriesRange('2026-07-09', '2026-07-17', 'day');

  assert.equal(sleep.sessions.length, 2);
  assert.equal(sleep.sessions[0].date, '2026-07-16');
  assert.equal(sleep.sessions[0].stages.length, 12);
  assert.equal(heartDay.points.length, 48);
  assert.deepEqual(Object.keys(heartDay.points[0]), ['time', 'averageBpm', 'minimumBpm', 'maximumBpm', 'count']);
  assert.equal(heartRange.days.length, 8);
  assert.equal(calorieDay.intervals.length, 24);
  assert.equal(Math.round(calorieDay.intervals.reduce((sum, point) => sum + point.activeKcal, 0)), 708);
  assert.equal(calorieRange.days.length, 8);
  assert.equal(calorieRange.days.at(-1).totalKcal, 2448);

  await pool.end();
});

test('heart ranges expose cold availability and combine permanent daily statistics exactly', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;

  for (const row of [
    {
      id: '91000000-0000-4000-8000-000000000001',
      date: '2026-01-15',
      resting: 55,
      average: 60,
      minimum: 50,
      maximum: 70,
      count: 2,
      coverage: 100,
      sum: 120,
      sumSquares: 7400,
      p05: 50,
      median: 60,
      p95: 70,
    },
    {
      id: '91000000-0000-4000-8000-000000000002',
      date: '2026-01-16',
      resting: 65,
      average: 100,
      minimum: 90,
      maximum: 110,
      count: 3,
      coverage: 200,
      sum: 300,
      sumSquares: 30200,
      p05: 90,
      median: 100,
      p95: 110,
    },
  ]) {
    await pool.query(
      `INSERT INTO heart_rate_daily_summaries (
         id, source_account_id, civil_date, resting_bpm, average_bpm, minimum_bpm,
         maximum_bpm, sample_count, coverage_seconds, bpm_sum, bpm_sum_of_squares,
         population_standard_deviation_bpm, p05_bpm, median_bpm, p95_bpm,
         aggregation_version, finalized_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12, $13, $14, 1, $15)`,
      [
        row.id,
        sourceAccountId,
        row.date,
        row.resting,
        row.average,
        row.minimum,
        row.maximum,
        row.count,
        row.coverage,
        row.sum,
        row.sumSquares,
        row.p05,
        row.median,
        row.p95,
        `${row.date}T23:59:59Z`,
      ],
    );
  }
  await pool.query(
    `INSERT INTO health_archive_catalog (
       id, source_account_id, archive_month, archive_version, is_active, state,
       heart_sample_count, calorie_interval_count, verified_at, pruned_at
     ) VALUES ($1, $2, '2026-01-01', 1, true, 'pruned', 5, 0, $3, $3)`,
    ['92000000-0000-4000-8000-000000000001', sourceAccountId, '2026-04-25T03:00:00Z'],
  );

  const repository = createHealthRepository(pool, {
    archiveConfigured: true,
    archivePruningEnabled: false,
    retentionDays: 90,
    now: () => Date.parse('2026-07-21T12:00:00Z'),
  });
  const aged = await repository.getHeartRange('2026-01-15', '2026-01-17', 'five-minute');
  const mixed = await repository.getHeartRange('2026-01-15', '2026-07-17', 'five-minute');
  const recent = await repository.getHeartRange('2026-07-16', '2026-07-17', 'five-minute');

  assert.deepEqual(aged.rawAvailability, {
    retainedFrom: '2026-07-09',
    requestedRangeFullyRaw: false,
    coldArchiveMonth: '2026-01-01',
  });
  assert.equal(aged.requestedResolution, 'five-minute');
  assert.equal(aged.resolution, 'day');
  assert.equal(aged.points.length, 0);
  assert.equal(aged.days.length, 2);
  assert.match(aged.detailUnavailableMessage, /encrypted cold storage/i);
  assert.equal(aged.periodSummary.sampleCount, 5);
  assert.equal(aged.periodSummary.bpmSum, 420);
  assert.equal(aged.periodSummary.bpmSumOfSquares, 37600);
  assert.equal(aged.periodSummary.averageBpm, 84);
  assert.equal(aged.periodSummary.populationStandardDeviationBpm, 21.54);
  assert.equal(aged.periodSummary.minimumBpm, 50);
  assert.equal(aged.periodSummary.maximumBpm, 110);
  assert.equal(aged.periodSummary.coverageSeconds, 300);
  assert.equal(aged.periodSummary.averageDailyRestingBpm, 60);
  assert.equal(aged.periodSummary.percentileSemantics, 'daily-distribution');
  assert.equal(aged.periodSummary.aggregationComplete, true);
  assert.equal(aged.periodSummary.unaggregatedDailySummaryCount, 0);
  assert.deepEqual(aged.periodSummary.percentilesBpm, { p05: 50, median: 80, p95: 110 });
  assert.equal(mixed.resolution, 'mixed');
  assert.equal(mixed.rawAvailability.requestedRangeFullyRaw, false);
  assert.equal(mixed.points.length, 384);
  assert.equal(mixed.days.length, 10);
  assert.equal(recent.rawAvailability.requestedRangeFullyRaw, true);
  assert.equal(recent.points.length, 48);

  await pool.end();
});

test('archive status reports safe operational metadata without object locations or hashes', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;
  await pool.query(
    `INSERT INTO health_archive_catalog (
       id, source_account_id, archive_month, archive_version, is_active, state,
       object_key, heart_sample_count, calorie_interval_count, plaintext_hash,
       ciphertext_hash, encryption_key_version, verified_at, error_code, error_message
     ) VALUES
       ($1, $3, '2026-01-01', 1, true, 'verified', 'private/secret-key', 10, 20,
        $4, $4, 1, $5, NULL, NULL),
       ($2, $3, '2026-02-01', 1, true, 'failed', NULL, 0, 0,
        NULL, NULL, NULL, NULL, 'ARCHIVE_BUILD_FAILED', 'Health archive build failed')`,
    [
      '93000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000002',
      sourceAccountId,
      'a'.repeat(64),
      '2026-04-25T03:00:00Z',
    ],
  );
  const repository = createHealthRepository(pool, {
    archiveConfigured: true,
    archivePruningEnabled: false,
    retentionDays: 90,
    now: () => Date.parse('2026-07-21T12:00:00Z'),
  });

  const status = await repository.getArchiveStatus();
  assert.equal(status.configured, true);
  assert.equal(status.pruningEnabled, false);
  assert.equal(status.hotCutoff, '2026-04-01');
  assert.equal(status.lastVerifiedMonth, '2026-01-01');
  assert.deepEqual(status.pendingMonths, []);
  assert.equal(status.failedMonths[0].month, '2026-02-01');
  assert.equal(status.failedMonths[0].errorCode, 'ARCHIVE_BUILD_FAILED');
  assert.equal(JSON.stringify(status).includes('private/secret-key'), false);
  assert.equal(JSON.stringify(status).includes('aaaaaaaa'), false);

  await pool.end();
});
