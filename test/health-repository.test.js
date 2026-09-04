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

test('calorie inspector separates source streams and explains the derived total', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;
  await pool.query(
    `UPDATE calorie_intervals
     SET device = $1
     WHERE source_account_id = $2
       AND civil_date = '2026-07-16'
       AND metric_type = 'active'
       AND start_time = '2026-07-16T00:00:00Z'`,
    [
      { displayName: 'Pixel Watch', identifier: 'private-device-id' },
      sourceAccountId,
    ],
  );
  const repository = createHealthRepository(pool);

  const inspector = await repository.getInspector?.('calories', '2026-07-16', {
    limit: 100,
  });

  assert.equal(inspector?.category, 'calories');
  assert.equal(inspector?.status, 'available');
  assert.deepEqual(inspector?.sourceFacts.dataTypes, [
    'active-energy-burned',
    'basal-energy-burned',
  ]);
  assert.equal(inspector?.sourceFacts.recordCount, 48);
  assert.deepEqual(
    inspector?.coverage.streams.map(({ name, recordCount }) => ({ name, recordCount })),
    [
      { name: 'active', recordCount: 24 },
      { name: 'basal', recordCount: 24 },
      { name: 'total', recordCount: 0 },
    ],
  );
  assert.deepEqual(inspector?.derived.find(({ field }) => field === 'totalKcal'), {
    field: 'totalKcal',
    value: 2448,
    unit: 'kcal',
    formula: 'activeKcal + basalKcal',
    inputFields: ['activeKcal', 'basalKcal'],
    inputState: { activeKcal: 'present', basalKcal: 'present' },
  });
  assert.equal(inspector?.records.total, 48);
  assert.equal(inspector?.records.items.length, 48);
  assert.equal(inspector?.records.nextCursor, null);
  assert.deepEqual(Object.keys(inspector?.records.items[0] ?? {}), [
    'metricType',
    'startTime',
    'endTime',
    'utcOffsetSeconds',
    'kilocalories',
    'device',
  ]);
  assert.deepEqual(inspector?.records.items[0].device, {
    displayName: 'Pixel Watch',
    identifier: '[redacted]',
  });
  assert.equal(JSON.stringify(inspector).includes('75ce6554-70c7-48be-a688-d0079384fcb1'), false);
  assert.equal(JSON.stringify(inspector).includes('fixture-calorie-'), false);
  assert.equal(JSON.stringify(inspector).includes('private-device-id'), false);

  await pool.end();
});

test('heart inspector labels source facts and application-derived daily statistics', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const repository = createHealthRepository(pool);

  const inspector = await repository.getInspector?.('heart', '2026-07-16', { limit: 100 });

  assert.equal(inspector?.category, 'heart');
  assert.equal(inspector?.status, 'available');
  assert.deepEqual(inspector?.sourceFacts.dataTypes, [
    'heart-rate',
    'daily-resting-heart-rate',
  ]);
  assert.equal(inspector?.normalized.summary.restingBpm, 58);
  assert.equal(inspector?.normalized.summary.restingDerived, false);
  assert.deepEqual(
    inspector?.derived.map(({ field, formula }) => ({ field, formula })),
    [
      { field: 'averageBpm', formula: 'sum(beatsPerMinute) / sampleCount' },
      { field: 'minimumBpm', formula: 'min(beatsPerMinute)' },
      { field: 'maximumBpm', formula: 'max(beatsPerMinute)' },
      { field: 'sampleCount', formula: 'count(heart-rate samples)' },
      { field: 'coverageSeconds', formula: 'occupied 5-minute buckets × 300 seconds' },
      {
        field: 'populationStandardDeviationBpm',
        formula: 'sqrt(mean(bpm²) - mean(bpm)²)',
      },
      { field: 'percentilesBpm', formula: 'continuous p05, p50, and p95 of daily samples' },
    ],
  );
  assert.equal(inspector?.coverage.civilDaySeconds, 86400);
  assert.equal(inspector?.coverage.streams[0].coverageSeconds, 12000);
  assert.equal(inspector?.coverage.streams[0].gapSeconds, 74400);
  assert.equal(inspector?.records.total, 48);
  assert.deepEqual(Object.keys(inspector?.records.items[0] ?? {}), [
    'sampledAt',
    'utcOffsetSeconds',
    'beatsPerMinute',
    'device',
  ]);
  assert.equal(inspector?.sourceJson.state, 'original');

  await pool.end();
});

test('sleep inspector distinguishes normalized retained source from original Google JSON', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const repository = createHealthRepository(pool);

  const inspector = await repository.getInspector?.('sleep', '2026-07-16', { limit: 100 });

  assert.equal(inspector?.category, 'sleep');
  assert.equal(inspector?.status, 'available');
  assert.deepEqual(inspector?.sourceFacts.dataTypes, ['sleep']);
  assert.equal(inspector?.sourceJson.state, 'normalized-only');
  assert.match(inspector?.sourceJson.reason, /normalized representation/i);
  assert.deepEqual(inspector?.normalized.summary, {
    date: '2026-07-16',
    startTime: '2026-07-16T03:17:00.000Z',
    endTime: '2026-07-16T09:54:00.000Z',
    startOffsetSeconds: -14400,
    endOffsetSeconds: -14400,
    sleepType: 'stages',
    isNap: false,
    durationMinutes: 397,
    minutesAsleep: 379,
    minutesAwake: 18,
    efficiency: 95.47,
    timeToSleepMinutes: 16,
    awakeEpisodes: 2,
    device: { manufacturer: 'Fixture', model: 'Deterministic Watch' },
  });
  assert.deepEqual(
    inspector?.derived.map(({ field, formula }) => ({ field, formula })),
    [
      { field: 'durationMinutes', formula: 'stored durationSeconds / 60' },
      { field: 'minutesAsleep', formula: 'stored asleepSeconds / 60' },
      { field: 'minutesAwake', formula: 'stored awakeSeconds / 60' },
      { field: 'efficiency', formula: 'minutesAsleep / durationMinutes × 100' },
      { field: 'stagePercentages', formula: 'stage minutes / durationMinutes × 100' },
      { field: 'awakeEpisodes', formula: 'count(awake stage intervals)' },
    ],
  );
  assert.equal(inspector?.coverage.streams[0].coverageSeconds, 23820);
  assert.equal(inspector?.coverage.streams[0].gapSeconds, 0);
  assert.equal(inspector?.records.total, 12);
  assert.deepEqual(Object.keys(inspector?.records.items[0] ?? {}), [
    'sequence',
    'stageType',
    'startTime',
    'endTime',
    'durationMinutes',
  ]);

  await pool.end();
});

test('inspector reports archive-only heart detail as unavailable without reconstruction', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;
  await pool.query(
    `INSERT INTO heart_rate_daily_summaries (
       id, source_account_id, civil_date, resting_bpm, average_bpm, minimum_bpm,
       maximum_bpm, sample_count, coverage_seconds, resting_derived, source_fields
     ) VALUES ($1, $2, '2026-01-15', 55, 66, 48, 110, 720, 43200, false, '{}')`,
    ['94000000-0000-4000-8000-000000000001', sourceAccountId],
  );
  await pool.query(
    `INSERT INTO health_archive_catalog (
       id, source_account_id, archive_month, archive_version, is_active, state,
       heart_sample_count, calorie_interval_count, verified_at, pruned_at
     ) VALUES ($1, $2, '2026-01-01', 1, true, 'pruned', 720, 0, $3, $3)`,
    [
      '94000000-0000-4000-8000-000000000002',
      sourceAccountId,
      '2026-04-25T03:00:00Z',
    ],
  );
  const repository = createHealthRepository(pool);

  const inspector = await repository.getInspector?.('heart', '2026-01-15');

  assert.equal(inspector?.status, 'partial');
  assert.equal(inspector?.coverage.storedState, 'summary-only');
  assert.equal(inspector?.records.total, 0);
  assert.equal(inspector?.sourceJson.state, 'unavailable');
  assert.match(inspector?.sourceJson.reason, /encrypted archive/i);

  await pool.end();
});

test('inspector source pages are redacted, bounded, and cursor-driven', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;
  await pool.query(
    `UPDATE calorie_intervals
     SET source_fields = $1
     WHERE source_account_id = $2
       AND civil_date = '2026-07-16'
       AND metric_type = 'active'
       AND start_time = '2026-07-16T00:00:00Z'`,
    [
      {
        dataPointName: 'accounts/private/dataPoints/private',
        activeEnergyBurned: {
          interval: {
            startTime: '2026-07-16T00:00:00Z',
            endTime: '2026-07-16T01:00:00Z',
          },
          kcal: 29.5,
        },
        dataSource: {
          device: { displayName: 'Pixel Watch', formFactor: 'FORM_FACTOR_WATCH' },
          application: { webClientId: 'private-client-id' },
        },
        accessToken: 'private-token',
      },
      sourceAccountId,
    ],
  );
  const repository = createHealthRepository(pool);

  const first = await repository.getInspectorSource?.('calories', '2026-07-16', {
    limit: 1,
  });
  const second = await repository.getInspectorSource?.('calories', '2026-07-16', {
    limit: 1,
    cursor: first?.nextCursor,
  });

  assert.equal(first?.state, 'original');
  assert.equal(first?.total, 48);
  assert.equal(first?.items.length, 1);
  assert.ok(first?.nextCursor);
  assert.deepEqual(Object.keys(first?.items[0] ?? {}), [
    'recordType',
    'dataType',
    'locator',
    'source',
  ]);
  assert.equal(first?.items[0].source.dataPointName, '[redacted]');
  assert.equal(first?.items[0].source.accessToken, '[redacted]');
  assert.equal(first?.items[0].source.dataSource.application.webClientId, '[redacted]');
  assert.equal(first?.items[0].source.dataSource.device.displayName, 'Pixel Watch');
  assert.equal(first?.items[0].source.activeEnergyBurned.kcal, 29.5);
  assert.notDeepEqual(first?.items[0].locator, second?.items[0].locator);
  assert.equal(JSON.stringify(first).includes('private-client-id'), false);
  assert.equal(JSON.stringify(first).includes('private-token'), false);

  await assert.rejects(
    repository.getInspectorSource?.('heart', '2026-07-16', {
      cursor: first?.nextCursor,
    }),
    /cursor/i,
  );

  await pool.end();
});

test('calorie inspector keeps returned zero distinct from a missing stream', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;
  await pool.query(
    `UPDATE calorie_intervals
     SET kilocalories = 0
     WHERE source_account_id = $1 AND civil_date = '2026-07-16' AND metric_type = 'active'`,
    [sourceAccountId],
  );
  await pool.query(
    `DELETE FROM calorie_intervals
     WHERE source_account_id = $1 AND civil_date = '2026-07-16' AND metric_type = 'basal'`,
    [sourceAccountId],
  );
  const repository = createHealthRepository(pool);

  const inspector = await repository.getInspector('calories', '2026-07-16');
  const active = inspector.coverage.streams.find(({ name }) => name === 'active');
  const basal = inspector.coverage.streams.find(({ name }) => name === 'basal');

  assert.equal(active.valueState, 'zero');
  assert.match(active.zeroSemantics, /does not prove the device was worn/i);
  assert.equal(basal.valueState, 'missing');
  assert.match(basal.zeroSemantics, /not treated as measured zero/i);
  assert.equal(basal.recordCount, 0);

  await pool.end();
});

test('missing inspector data still reports the latest successful sync age', async () => {
  const pool = await createFixtureDatabase();
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const sourceAccountId = (
    await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
  ).rows[0].id;
  await pool.query(
    `INSERT INTO sync_jobs (
       id, source_account_id, job_type, status, metrics, requested_by, finished_at
     ) VALUES ($1, $2, 'recent', 'completed', '[]', 'test', $3)`,
    [
      '95000000-0000-4000-8000-000000000001',
      sourceAccountId,
      '2026-07-17T01:02:03Z',
    ],
  );
  const repository = createHealthRepository(pool);

  const inspector = await repository.getInspector('calories', '2026-06-01');

  assert.equal(inspector.status, 'missing');
  assert.equal(inspector.dataAge.lastSuccessfulSync, '2026-07-17T01:02:03.000Z');
  assert.equal(inspector.dataAge.normalizedUpdatedAt, null);
  assert.equal(inspector.dataAge.sourceUpdatedAt, null);
  assert.equal(inspector.sourceFacts.recordCount, 0);
  assert.deepEqual(inspector.records, { items: [], total: 0, nextCursor: null });

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
