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
