import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCompactHealthArgs,
  runCompactHealthOperation,
} from '../lib/db/compact-backfill.js';

const accountId = '11111111-1111-1111-1111-111111111111';

function legacyPool({ hearts = [], calories = [], validation = { heart: [], calories: [] } } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM source_accounts')) return { rows: [{ id: accountId }] };
      if (sql.includes('FROM heart_rate_samples') && sql.includes('ORDER BY id')) {
        const [sourceAccountId, cursor, limit] = params;
        assert.equal(sourceAccountId, accountId);
        return { rows: hearts.filter(({ id }) => !cursor || id > cursor).slice(0, limit) };
      }
      if (sql.includes('FROM calorie_intervals') && sql.includes('ORDER BY id')) {
        const [sourceAccountId, cursor, limit] = params;
        assert.equal(sourceAccountId, accountId);
        return { rows: calories.filter(({ id }) => !cursor || id > cursor).slice(0, limit) };
      }
      if (sql.includes('heart_rate_samples_compact') && sql.includes('FULL OUTER JOIN')) {
        return { rows: validation.heart };
      }
      if (sql.includes('calorie_intervals_compact') && sql.includes('FULL OUTER JOIN')) {
        return { rows: validation.calories };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function heart(id, sampledAt, beatsPerMinute = 70) {
  return {
    id,
    provider_id: `provider-${id}`,
    civil_date: sampledAt.slice(0, 10),
    sampled_at: sampledAt,
    utc_offset_seconds: -14400,
    beats_per_minute: beatsPerMinute,
    device: { model: 'Watch' },
    source_fields: { dataSource: { device: { model: 'Watch' } } },
  };
}

test('compact operator defaults to read-only validation and requires explicit backfill execution', () => {
  assert.deepEqual(parseCompactHealthArgs([]), {
    mode: 'validate',
    execute: false,
    batchSize: 1000,
  });
  assert.deepEqual(parseCompactHealthArgs(['--backfill', '--batch-size', '25']), {
    mode: 'backfill',
    execute: false,
    batchSize: 25,
  });
  assert.deepEqual(parseCompactHealthArgs(['--backfill', '--execute', '--batch-size=50']), {
    mode: 'backfill',
    execute: true,
    batchSize: 50,
  });
  assert.throws(() => parseCompactHealthArgs(['--execute']), /requires --backfill/);
  assert.throws(() => parseCompactHealthArgs(['--batch-size', '0']), /positive integer/);
  assert.throws(() => parseCompactHealthArgs(['--unknown']), /Unknown compact health option/);
});

test('dry-run backfill scans bounded batches without writing or deleting source rows', async () => {
  const pool = legacyPool({
    hearts: [
      heart('00000000-0000-0000-0000-000000000001', '2026-07-16T12:00:00Z'),
      heart('00000000-0000-0000-0000-000000000002', '2026-07-17T12:00:00Z'),
      heart('00000000-0000-0000-0000-000000000003', '2026-07-18T12:00:00Z'),
    ],
  });
  let compactWrites = 0;
  let finalizations = 0;

  const result = await runCompactHealthOperation({
    pool,
    mode: 'backfill',
    execute: false,
    batchSize: 2,
    compactWriter: {
      async upsertHeartSamples() { compactWrites += 1; },
      async upsertCalorieIntervals() { compactWrites += 1; },
    },
    metricWriter: {
      async recalculateDaily() { finalizations += 1; },
    },
  });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.sourceRows, { heart: 3, calories: 0 });
  assert.equal(compactWrites, 0);
  assert.equal(finalizations, 0);
  assert.ok(pool.queries.filter(({ sql }) => sql.includes('FROM heart_rate_samples')).length >= 2);
  assert.ok(pool.queries.every(({ params }) => !params[2] || params[2] <= 2));
  assert.ok(pool.queries.every(({ sql }) => !/\bDELETE\b/.test(sql)));
});

test('backfill preflight aborts duplicate semantic identities before the first compact write', async () => {
  const duplicateTime = '2026-07-16T12:00:00Z';
  const pool = legacyPool({
    hearts: [
      heart('00000000-0000-0000-0000-000000000001', duplicateTime, 70),
      heart('00000000-0000-0000-0000-000000000002', duplicateTime, 72),
    ],
  });
  let compactWrites = 0;

  await assert.rejects(
    runCompactHealthOperation({
      pool,
      mode: 'backfill',
      execute: true,
      batchSize: 1,
      compactWriter: {
        async upsertHeartSamples() { compactWrites += 1; },
        async upsertCalorieIntervals() { compactWrites += 1; },
      },
      metricWriter: { async recalculateDaily() {} },
    }),
    /Duplicate heart semantic identity/,
  );
  assert.equal(compactWrites, 0);
});

test('executed backfill writes bounded pages, refreshes each affected date once, and validates', async () => {
  const pool = legacyPool({
    hearts: [
      heart('00000000-0000-0000-0000-000000000001', '2026-07-16T12:00:00Z'),
      heart('00000000-0000-0000-0000-000000000002', '2026-07-16T12:05:00Z'),
      heart('00000000-0000-0000-0000-000000000003', '2026-07-17T12:00:00Z'),
    ],
  });
  const pageSizes = [];
  const dates = [];

  const result = await runCompactHealthOperation({
    pool,
    mode: 'backfill',
    execute: true,
    batchSize: 2,
    compactWriter: {
      async upsertHeartSamples(_account, samples) {
        pageSizes.push(samples.length);
        return { inserted: samples.length, updated: 0, unchanged: 0 };
      },
      async upsertCalorieIntervals(_account, intervals) {
        pageSizes.push(intervals.length);
        return { inserted: intervals.length, updated: 0, unchanged: 0 };
      },
    },
    metricWriter: {
      async recalculateDaily(_account, date) { dates.push(date); },
    },
  });

  assert.deepEqual(pageSizes, [2, 1]);
  assert.deepEqual(dates, ['2026-07-16', '2026-07-17']);
  assert.deepEqual(result.compactWrites.heart, { inserted: 3, updated: 0, unchanged: 0 });
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.validation.mismatches, { heart: [], calories: [] });
});
