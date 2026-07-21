import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { ARCHIVE_SCHEMAS } from '../lib/archive/bundle.js';
import { encodeCsvRow } from '../lib/archive/csv.js';
import { createHealthArchiveRepository } from '../lib/archive/repository.js';
import { applyMigrations } from '../lib/db/migrations.js';

const sourceAccountId = '11111111-1111-1111-1111-111111111111';

async function createDatabase() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  await pool.query(
    `INSERT INTO source_accounts (id, provider, provider_account_id)
     VALUES ($1, 'google', 'archive-test')`,
    [sourceAccountId],
  );
  return pool;
}

test('catalog reservation and verified transitions are resumable and idempotent', async () => {
  const pool = await createDatabase();
  const repository = createHealthArchiveRepository(pool);

  try {
    await repository.withMonthLock(sourceAccountId, '2026-01-01', async (locked) => {
      const first = await locked.reserveMonth(sourceAccountId, '2026-01-01');
      const second = await locked.reserveMonth(sourceAccountId, '2026-01-01');
      assert.equal(first.id, second.id);
      assert.equal(first.archive_version, 1);
      await locked.markBuilding(first.id);
      await locked.recordBuilt(first.id, {
        objectKey: `health-hub/raw/v1/2026/01/health-raw-2026-01-${'a'.repeat(64)}.hharchive`,
        heartSampleCount: 2,
        calorieIntervalCount: 1,
        measurementStartedAt: '2026-01-02T12:00:00Z',
        measurementEndedAt: '2026-01-02T12:05:00Z',
        byteSize: 123,
        plaintextHash: 'b'.repeat(64),
        ciphertextHash: 'a'.repeat(64),
        encryptionKeyVersion: 1,
      });
      await locked.markUploaded(first.id);
      await locked.markVerified(first.id);
    });

    const page = await repository.list({ sourceAccountId, archiveMonth: '2026-01-01' });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].state, 'verified');
    assert.ok(page.items[0].verified_at);
    assert.equal(Number(page.items[0].heart_sample_count), 2);
    assert.equal(page.nextCursor, null);
  } finally {
    await pool.end();
  }
});

test('catalog list is hard bounded and uses a stable opaque cursor', async () => {
  const pool = await createDatabase();
  const repository = createHealthArchiveRepository(pool);
  try {
    for (const [id, month, version] of [
      ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-03-01', 1],
      ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-02-01', 1],
      ['cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-01-01', 1],
    ]) {
      await pool.query(
        `INSERT INTO health_archive_catalog
          (id, source_account_id, archive_month, archive_version, is_active, state)
         VALUES ($1, $2, $3, $4, true, 'pending')`,
        [id, sourceAccountId, month, version],
      );
    }
    const first = await repository.list({ limit: 2 });
    const second = await repository.list({ limit: 2, cursor: first.nextCursor });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(
      [...first.items, ...second.items].map(({ id }) => id),
      [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        'cccccccc-cccc-cccc-cccc-cccccccccccc',
      ],
    );
    await assert.rejects(repository.list({ limit: 101 }), /between 1 and 100/);
    await assert.rejects(repository.list({ cursor: 'not-a-cursor' }), /Invalid archive catalog cursor/);
  } finally {
    await pool.end();
  }
});

test('a failed rebuild is superseded and receives a new immutable catalog version', async () => {
  const pool = await createDatabase();
  const repository = createHealthArchiveRepository(pool);

  try {
    const first = await repository.withMonthLock(sourceAccountId, '2026-01-01', async (locked) => {
      const reserved = await locked.reserveMonth(sourceAccountId, '2026-01-01');
      await locked.recordFailure(reserved.id, {
        errorCode: 'ARCHIVE_BUILD_FAILED',
        errorMessage: 'Health archive build failed',
      });
      return reserved;
    });
    const second = await repository.withMonthLock(sourceAccountId, '2026-01-01', (locked) =>
      locked.reserveMonth(sourceAccountId, '2026-01-01'));
    const rows = await pool.query(
      `SELECT archive_version, is_active, state
       FROM health_archive_catalog
       WHERE source_account_id = $1
       ORDER BY archive_version`,
      [sourceAccountId],
    );

    assert.notEqual(first.id, second.id);
    assert.equal(second.archive_version, 2);
    assert.deepEqual(rows.rows, [
      { archive_version: 1, is_active: false, state: 'superseded' },
      { archive_version: 2, is_active: true, state: 'pending' },
    ]);
  } finally {
    await pool.end();
  }
});

test('catalog failures accept only predefined safe metadata', async () => {
  const pool = await createDatabase();
  const repository = createHealthArchiveRepository(pool);
  try {
    const row = await repository.reserveMonth(sourceAccountId, '2026-01-01');
    await assert.rejects(
      repository.recordFailure(row.id, {
        errorCode: 'raw-secret',
        errorMessage: 'credential=secret',
      }),
      /safe archive error metadata/,
    );
  } finally {
    await pool.end();
  }
});

test('verification failure metadata preserves an already pruned catalog state', async () => {
  const pool = await createDatabase();
  const repository = createHealthArchiveRepository(pool);
  try {
    await pool.query(
      `INSERT INTO health_archive_catalog
        (id, source_account_id, archive_month, archive_version, state, verified_at, pruned_at)
       VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', $1, '2026-01-01', 1,
               'pruned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [sourceAccountId],
    );
    const row = await repository.recordVerificationFailure(
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
      { errorCode: 'ARCHIVE_VERIFY_FAILED', errorMessage: 'Health archive verify failed' },
    );
    assert.equal(row.state, 'pruned');
    assert.equal(row.error_code, 'ARCHIVE_VERIFY_FAILED');
    assert.equal(row.error_message, 'Health archive verify failed');
  } finally {
    await pool.end();
  }
});

const heartRows = [
  ['33333333-3333-3333-3333-333333333333', '2026-01-02', '2026-01-02T12:00:00.000Z', '\\N', '70', 'heart-1'],
  ['33333333-3333-3333-3333-333333333333', '2026-01-02', '2026-01-02T12:01:00.000Z', '-18000', '71', '\\N'],
  ['33333333-3333-3333-3333-333333333333', '2026-01-02', '2026-01-02T12:02:00.000Z', '-18000', '72', 'heart-3'],
];
const calorieRows = [
  ['44444444-4444-4444-4444-444444444444', '2026-01-02', 'active', '2026-01-02T12:00:00.000Z', '2026-01-02T12:05:00.000Z', '-18000', '2.5000', 'calorie-1'],
];

async function createArchiveDirectory({ hearts = heartRows, calories = calorieRows } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'health-prune-stage-'));
  await writeFile(
    path.join(directory, 'heart-rate-samples.csv'),
    [ARCHIVE_SCHEMAS['heart-rate-samples.csv'], ...hearts].map(encodeCsvRow).join(''),
  );
  await writeFile(
    path.join(directory, 'calorie-intervals.csv'),
    [ARCHIVE_SCHEMAS['calorie-intervals.csv'], ...calories].map(encodeCsvRow).join(''),
  );
  return directory;
}

function createPruneDatabase({
  state = 'verified',
  heartSampleCount = heartRows.length,
  calorieIntervalCount = calorieRows.length,
  heartMismatch = false,
  calorieMismatch = false,
  heartDeleteRows = [0],
  calorieDeleteRows = [0],
  remainingHeart = 0,
  remainingCalories = 0,
} = {}) {
  const queries = [];
  let catalogState = state;
  let heartIndex = 0;
  let calorieIndex = 0;
  const client = {
    released: false,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT * FROM health_archive_catalog WHERE id')) {
        return { rows: [{
          id: 'catalog-id',
          source_account_id: sourceAccountId,
          archive_month: '2026-01-01',
          state: catalogState,
          is_active: true,
          verified_at: new Date(),
          heart_sample_count: heartSampleCount,
          calorie_interval_count: calorieIntervalCount,
        }] };
      }
      if (sql.includes('AS heart_mismatch')) {
        return { rows: [{ heart_mismatch: heartMismatch, calorie_mismatch: calorieMismatch }] };
      }
      if (sql.includes("SET state = 'pruning'")) {
        catalogState = 'pruning';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM heart_rate_samples_compact')) {
        return { rows: [], rowCount: heartDeleteRows[heartIndex++] ?? 0 };
      }
      if (sql.includes('DELETE FROM calorie_intervals_compact')) {
        return { rows: [], rowCount: calorieDeleteRows[calorieIndex++] ?? 0 };
      }
      if (sql.includes('AS heart_count')) {
        return { rows: [{ heart_count: remainingHeart, calorie_count: remainingCalories }] };
      }
      if (sql.includes("SET state = 'pruned'")) {
        catalogState = 'pruned';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release() { this.released = true; },
  };
  return {
    queries,
    client,
    get state() { return catalogState; },
    async connect() { return client; },
  };
}

async function withArchiveDirectory(options, operation) {
  const directory = await createArchiveDirectory(options);
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('prune preflight aborts an incomplete compact backfill before deleting any rows', async () => {
  await withArchiveDirectory({}, async (archiveDirectory) => {
    const database = createPruneDatabase({ heartMismatch: true });
    const repository = createHealthArchiveRepository(database);
    await assert.rejects(
      repository.pruneVerifiedMonth('catalog-id', { archiveDirectory, batchSize: 2 }),
      /do not exactly match/,
    );
    assert.ok(!database.queries.some(({ sql }) => sql.includes('DELETE FROM')));
    assert.ok(database.queries.some(({ sql }) => sql.includes('ARCHIVE_PRUNE_FAILED')));
  });
});

test('prune preflight rejects a corrected row with the same compact identity', async () => {
  await withArchiveDirectory({}, async (archiveDirectory) => {
    const database = createPruneDatabase({ calorieMismatch: true });
    const repository = createHealthArchiveRepository(database);
    await assert.rejects(
      repository.pruneVerifiedMonth('catalog-id', { archiveDirectory, batchSize: 2 }),
      /do not exactly match/,
    );
    const preflight = database.queries.find(({ sql }) => sql.includes('AS heart_mismatch')).sql;
    assert.match(preflight, /beats_per_minute IS NOT DISTINCT FROM raw\.beats_per_minute/);
    assert.match(preflight, /kilocalories IS NOT DISTINCT FROM raw\.kilocalories/);
  });
});

test('prune resumes safely when some archived rows are already absent', async () => {
  await withArchiveDirectory({}, async (archiveDirectory) => {
    const database = createPruneDatabase({
      state: 'pruning',
      heartDeleteRows: [1, 0],
      calorieDeleteRows: [0],
    });
    const repository = createHealthArchiveRepository(database);
    const removed = await repository.pruneVerifiedMonth('catalog-id', {
      archiveDirectory,
      batchSize: 2,
    });
    assert.deepEqual(removed, { compactHeartRateSamples: 1, compactCalorieIntervals: 0 });
    assert.equal(database.state, 'pruned');
  });
});

test('a late compact row prevents a pruning catalog from being marked pruned', async () => {
  await withArchiveDirectory({}, async (archiveDirectory) => {
    const database = createPruneDatabase({
      heartDeleteRows: [1, 0],
      calorieDeleteRows: [1, 0],
      remainingHeart: 1,
    });
    const repository = createHealthArchiveRepository(database);
    await assert.rejects(
      repository.pruneVerifiedMonth('catalog-id', { archiveDirectory, batchSize: 2 }),
      /Compact rows remain/,
    );
    assert.equal(database.state, 'pruning');
    assert.ok(database.queries.some(({ sql }) => sql.includes('ARCHIVE_PRUNE_FAILED')));
  });
});

test('successful prune uses one owned client, exact compact-only deletes, and bounded batches', async () => {
  await withArchiveDirectory({}, async (archiveDirectory) => {
    const database = createPruneDatabase({
      heartDeleteRows: [2, 1],
      calorieDeleteRows: [1],
    });
    const repository = createHealthArchiveRepository(database);
    const removed = await repository.pruneVerifiedMonth('catalog-id', {
      archiveDirectory,
      batchSize: 2,
    });
    assert.deepEqual(removed, { compactHeartRateSamples: 3, compactCalorieIntervals: 1 });
    assert.equal(database.state, 'pruned');
    assert.equal(database.client.released, true);
    const deleteQueries = database.queries.filter(({ sql }) => sql.includes('DELETE FROM'));
    assert.equal(deleteQueries.length, 3);
    assert.ok(deleteQueries.every(({ params }) => params[1] === 2));
    assert.ok(deleteQueries.every(({ sql }) => sql.includes('health_archive_prune_')));
    assert.ok(deleteQueries.every(({ sql }) => !/DELETE FROM (heart_rate_samples|calorie_intervals) AS/.test(sql)));
    assert.ok(database.queries.some(({ sql }) => sql.includes('IN SHARE ROW EXCLUSIVE MODE')));
  });
});
