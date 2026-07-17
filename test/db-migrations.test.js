import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';

test('initial migration creates the permanent health archive tables once', async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();

  const first = await applyMigrations(pool);
  const second = await applyMigrations(pool);
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);

  assert.deepEqual(first, ['001_initial.sql']);
  assert.deepEqual(second, []);
  assert.deepEqual(
    tables.rows.map(({ table_name: name }) => name),
    [
      'calorie_daily_summaries',
      'calorie_intervals',
      'daily_health_summaries',
      'export_jobs',
      'heart_rate_daily_summaries',
      'heart_rate_samples',
      'journal_entries',
      'journal_entry_revisions',
      'journal_entry_tags',
      'journal_tags',
      'schema_migrations',
      'sleep_sessions',
      'sleep_stages',
      'source_accounts',
      'sync_chunks',
      'sync_jobs',
    ],
  );

  await pool.end();
});
