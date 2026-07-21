import assert from 'node:assert/strict';
import test from 'node:test';

import { createCompactMetricWriter } from '../lib/db/compact-metric-writer.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import {
  canonicalizeSourceMetadata,
  hashSourceMetadata,
} from '../lib/metrics/source-metadata.js';

const accountId = '11111111-1111-1111-1111-111111111111';

function heartSample(overrides = {}) {
  return {
    civilDate: '2026-11-01',
    sampledAt: '2026-11-01T05:30:00Z',
    utcOffsetSeconds: -14400,
    beatsPerMinute: 61,
    providerId: 'heart-point',
    sourceMetadata: {
      dataType: 'heart-rate',
      dataSource: { device: { manufacturer: 'Acme', model: 'Watch' } },
    },
    ...overrides,
  };
}

function recordingPool(compactResults = []) {
  const queries = [];
  let streamSequence = 0;
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO source_streams')) {
        streamSequence += 1;
        return { rows: [{ id: `00000000-0000-0000-0000-00000000000${streamSequence}` }] };
      }
      if (sql.includes('_compact')) return compactResults.shift() ?? { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('canonical source metadata recursively ignores object key order', () => {
  const left = {
    dataType: 'heart-rate',
    dataSource: {
      application: { version: '1', name: 'Health' },
      device: { model: 'Watch', manufacturer: 'Acme' },
    },
  };
  const right = {
    dataSource: {
      device: { manufacturer: 'Acme', model: 'Watch' },
      application: { name: 'Health', version: '1' },
    },
    dataType: 'heart-rate',
  };

  assert.deepEqual(canonicalizeSourceMetadata(left), canonicalizeSourceMetadata(right));
  assert.equal(hashSourceMetadata(left), hashSourceMetadata(right));
  assert.match(hashSourceMetadata(left), /^[a-f0-9]{64}$/);
});

test('compact heart pages resolve streams then use one set-based statement with write counts', async () => {
  const pool = recordingPool([{ rows: [{ inserted: true }, { inserted: false }] }]);
  const writer = createCompactMetricWriter(pool);
  const samples = [
    heartSample(),
    heartSample({
      sampledAt: '2026-11-01T06:30:00Z',
      utcOffsetSeconds: -18000,
      beatsPerMinute: 63,
    }),
    heartSample({
      sourceMetadata: {
        dataSource: { device: { manufacturer: 'Other', model: 'Ring' } },
        dataType: 'heart-rate',
      },
    }),
  ];

  const counts = await writer.upsertHeartSamples(accountId, samples);
  const compactQueries = pool.queries.filter(({ sql }) =>
    sql.includes('INSERT INTO heart_rate_samples_compact'),
  );

  assert.deepEqual(counts, { inserted: 1, updated: 1, unchanged: 1 });
  assert.equal(compactQueries.length, 1);
  const rows = JSON.parse(compactQueries[0].params[1]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(({ civilDate, utcOffsetSeconds, beatsPerMinute }) => ({
    civilDate,
    utcOffsetSeconds,
    beatsPerMinute,
  })), [
    { civilDate: '2026-11-01', utcOffsetSeconds: -14400, beatsPerMinute: 61 },
    { civilDate: '2026-11-01', utcOffsetSeconds: -18000, beatsPerMinute: 63 },
    { civilDate: '2026-11-01', utcOffsetSeconds: -14400, beatsPerMinute: 61 },
  ]);
  assert.match(compactQueries[0].sql, /ON CONFLICT \(source_stream_id, sampled_at\)/);
  assert.match(compactQueries[0].sql, /IS DISTINCT FROM/);
});

test('source stream resolution reads the winning row after an insert conflict', async () => {
  const existingId = '00000000-0000-0000-0000-000000000099';
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('INSERT INTO source_streams')) return { rows: [] };
      if (sql.includes('SELECT id FROM source_streams')) return { rows: [{ id: existingId }] };
      if (sql.includes('INSERT INTO heart_rate_samples_compact')) {
        return { rows: [{ inserted: true }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  assert.deepEqual(await createCompactMetricWriter(pool).upsertHeartSamples(accountId, [heartSample()]), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  assert.equal(queries.filter((sql) => sql.includes('source_streams')).length, 2);
});

test('compact calorie pages preserve measured zero and reject duplicate semantic identities', async () => {
  const pool = recordingPool([{ rows: [{ inserted: true }] }]);
  const writer = createCompactMetricWriter(pool);
  const interval = {
    civilDate: '2026-11-01',
    metricType: 'active',
    startTime: '2026-11-01T05:00:00Z',
    endTime: '2026-11-01T06:00:00Z',
    utcOffsetSeconds: -14400,
    kilocalories: 0,
    sourceMetadata: { dataType: 'active-energy-burned', dataSource: {} },
  };

  assert.deepEqual(await writer.upsertCalorieIntervals(accountId, [interval]), {
    inserted: 1,
    updated: 0,
    unchanged: 0,
  });
  const compactQuery = pool.queries.find(({ sql }) =>
    sql.includes('INSERT INTO calorie_intervals_compact'),
  );
  assert.equal(JSON.parse(compactQuery.params[1])[0].kilocalories, 0);

  await assert.rejects(
    writer.upsertCalorieIntervals(accountId, [
      interval,
      { ...interval, endTime: '2026-11-01T06:05:00Z', kilocalories: 1 },
    ]),
    /Duplicate calorie semantic identity/,
  );
});

test('legacy writes remain active while compact dual writes default off and require opt-in', async () => {
  const legacyQueries = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          legacyQueries.push(sql);
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const compactCalls = [];
  const compactWriter = {
    async upsertHeartSamples(sourceAccountId, samples) {
      compactCalls.push({ sourceAccountId, samples });
      return { inserted: 1, updated: 0, unchanged: 0 };
    },
  };

  const disabled = createMetricWriter(pool, { compactWriter });
  const disabledResult = await disabled.upsertHeartSamples(accountId, [heartSample()]);
  const enabled = createMetricWriter(pool, { compactWritesEnabled: true, compactWriter });
  const enabledResult = await enabled.upsertHeartSamples(accountId, [heartSample()]);

  assert.equal(legacyQueries.filter((sql) => sql.includes('INSERT INTO heart_rate_samples')).length, 2);
  assert.equal(compactCalls.length, 1);
  assert.deepEqual(disabledResult, { inserted: 0, updated: 0, unchanged: 0, skipped: 1 });
  assert.deepEqual(enabledResult, { inserted: 1, updated: 0, unchanged: 0 });
});

test('metric writer does not reconnect or release a caller-owned client', async () => {
  const queries = [];
  let connectCalls = 0;
  let releaseCalls = 0;
  const transactionClient = {
    async connect() {
      connectCalls += 1;
      throw new Error('caller-owned client must not be reconnected');
    },
    async query(sql) {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {
      releaseCalls += 1;
    },
  };
  const writer = createMetricWriter(transactionClient, { clientOwnedByCaller: true });

  await writer.upsertHeartSamples(accountId, [heartSample({ providerKey: 'transaction-heart' })]);

  assert.equal(connectCalls, 0);
  assert.equal(releaseCalls, 0);
  assert.equal(queries[0], 'BEGIN');
  assert.match(queries[1], /INSERT INTO heart_rate_samples/);
  assert.equal(queries.at(-1), 'COMMIT');
});

test('daily recalculation serializes queries on a caller-owned client', async () => {
  const queries = [];
  let queryInFlight = false;
  const transactionClient = {
    async query(sql) {
      if (queryInFlight) throw new Error('borrowed client received overlapping queries');
      queryInFlight = true;
      queries.push(sql);
      await new Promise((resolve) => setImmediate(resolve));
      queryInFlight = false;
      return { rows: [], rowCount: 0 };
    },
  };
  const writer = createMetricWriter(transactionClient, { clientOwnedByCaller: true });

  await writer.recalculateDaily(accountId, '2026-11-01');

  assert.equal(queries.filter((sql) => sql.includes('SELECT * FROM')).length, 3);
  assert.match(queries.at(-1), /INSERT INTO daily_health_summaries/);
});
