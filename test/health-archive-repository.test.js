import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

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

    const rows = await repository.list({ sourceAccountId, archiveMonth: '2026-01-01' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'verified');
    assert.ok(rows[0].verified_at);
    assert.equal(Number(rows[0].heart_sample_count), 2);
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

test('verified pruning uses bounded authorized deletes for compact and legacy exact rows', async () => {
  const queries = [];
  const database = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT * FROM health_archive_catalog WHERE id')) {
        return { rows: [{ id: 'catalog-id', state: 'verified', verified_at: new Date() }] };
      }
      if (sql.includes('WITH authorized')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  const repository = createHealthArchiveRepository(database);

  const removed = await repository.pruneVerifiedMonth('catalog-id', { batchSize: 25 });
  const deletes = queries.filter(({ sql }) => sql.includes('WITH authorized'));

  assert.deepEqual(removed, {
    heartRateSamples: 0,
    calorieIntervals: 0,
    compactHeartRateSamples: 0,
    compactCalorieIntervals: 0,
  });
  for (const table of [
    'heart_rate_samples_compact',
    'calorie_intervals_compact',
    'heart_rate_samples',
    'calorie_intervals',
  ]) {
    assert.ok(deletes.some(({ sql }) => sql.includes(`FROM ${table} AS raw`)));
  }
  const compactHeart = deletes.find(({ sql }) => sql.includes('FROM heart_rate_samples_compact AS raw')).sql;
  const compactCalories = deletes.find(({ sql }) => sql.includes('FROM calorie_intervals_compact AS raw')).sql;
  assert.match(compactHeart, /SELECT raw\.source_stream_id, raw\.sampled_at/);
  assert.doesNotMatch(compactHeart, /SELECT raw\.id/);
  assert.match(compactCalories, /SELECT raw\.source_stream_id, raw\.interval_type, raw\.start_at/);
  assert.doesNotMatch(compactCalories, /SELECT raw\.id/);
  assert.ok(deletes.every(({ sql, params }) =>
    sql.includes("state = 'pruning'") && sql.includes('verified_at IS NOT NULL') && params[1] === 25));
});
