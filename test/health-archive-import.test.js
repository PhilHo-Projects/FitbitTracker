import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { buildMonthBundle, extractMonthBundle } from '../lib/archive/bundle.js';
import {
  assertSafeImportTarget,
  importExtractedMonth,
} from '../lib/archive/import.js';
import { applyMigrations } from '../lib/db/migrations.js';

const sourceAccountId = '11111111-1111-1111-1111-111111111111';
const sourceStreamId = '22222222-2222-2222-2222-222222222222';

function sourcePool() {
  let heartReturned = false;
  let calorieReturned = false;
  let streamReturned = false;
  return {
    async query(sql) {
      if (sql.includes('FROM source_streams')) {
        if (streamReturned) return { rows: [] };
        streamReturned = true;
        return { rows: [{
          id: sourceStreamId,
          metadata: { dataType: 'heart-rate', device: { model: 'Watch' } },
          metadata_hash: 'a'.repeat(64),
        }] };
      }
      if (sql.includes('FROM heart_rate_samples_compact')) {
        if (heartReturned) return { rows: [] };
        heartReturned = true;
        return { rows: [{
          source_stream_id: sourceStreamId,
          civil_date: '2026-01-02',
          sampled_at: '2026-01-02T12:00:00.000Z',
          utc_offset_seconds: -18000,
          beats_per_minute: '70.00',
          upstream_sample_id: 'heart-one',
        }] };
      }
      if (sql.includes('FROM calorie_intervals_compact')) {
        if (calorieReturned) return { rows: [] };
        calorieReturned = true;
        return { rows: [{
          source_stream_id: sourceStreamId,
          civil_date: '2026-01-02',
          interval_type: 'active',
          start_at: '2026-01-02T12:00:00.000Z',
          end_at: '2026-01-02T12:05:00.000Z',
          utc_offset_seconds: -18000,
          kilocalories: '0.0000',
          upstream_sample_id: null,
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('archive import refuses the current database and production-looking targets by default', () => {
  const current = 'postgres://user:password@127.0.0.1:5432/health_hub';
  assert.throws(
    () => assertSafeImportTarget({ targetDatabaseUrl: current, currentDatabaseUrl: current }),
    /current DATABASE_URL/,
  );
  assert.throws(
    () => assertSafeImportTarget({
      targetDatabaseUrl: 'postgres://restore:password@db.example.com:5432/health_hub_restore',
      currentDatabaseUrl: current,
    }),
    /production-looking target/,
  );
  assert.doesNotThrow(() => assertSafeImportTarget({
    targetDatabaseUrl: 'postgres://restore:password@db.example.com:5432/health_hub_restore',
    currentDatabaseUrl: current,
    allowProductionTarget: true,
  }));
  assert.doesNotThrow(() => assertSafeImportTarget({
    targetDatabaseUrl: 'postgres://restore:password@127.0.0.1:5432/health_hub_restore_test',
    currentDatabaseUrl: current,
  }));
});

test('archive import is bounded and idempotently restores exact compact measurements', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'health-import-'));
  const files = path.join(root, 'files');
  const extracted = path.join(root, 'extracted');
  const bundle = path.join(root, 'bundle.gz');
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();

  try {
    await buildMonthBundle({
      pool: sourcePool(),
      sourceAccountId,
      archiveMonth: '2026-01-01',
      directory: files,
      outputPath: bundle,
      batchSize: 1,
    });
    await extractMonthBundle({ inputPath: bundle, outputDirectory: extracted });
    await applyMigrations(pool);
    await pool.query(
      `INSERT INTO source_accounts (id, provider, provider_account_id)
       VALUES ($1, 'archive-import', 'restore-target')`,
      [sourceAccountId],
    );

    const first = await importExtractedMonth({ directory: extracted, targetPool: pool, batchSize: 1 });
    const second = await importExtractedMonth({ directory: extracted, targetPool: pool, batchSize: 1 });
    const heart = await pool.query('SELECT * FROM heart_rate_samples_compact');
    const calories = await pool.query('SELECT * FROM calorie_intervals_compact');

    assert.deepEqual(first, { sourceStreams: 1, heartSamples: 1, calorieIntervals: 1 });
    assert.deepEqual(second, first);
    assert.equal(heart.rowCount, 1);
    assert.equal(Number(heart.rows[0].beats_per_minute), 70);
    assert.equal(calories.rowCount, 1);
    assert.equal(Number(calories.rows[0].kilocalories), 0);
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
