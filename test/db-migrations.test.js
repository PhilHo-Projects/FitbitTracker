import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';

test('migrations create the permanent health archive tables once', async () => {
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

  assert.deepEqual(first, [
    '001_initial.sql',
    '002_sync_queue_concurrency.sql',
    '003_sync_claim_leases.sql',
    '004_lifelong_health_archive.sql',
    '005_health_archive_catalog_month_constraint.sql',
  ]);
  assert.deepEqual(second, []);
  assert.deepEqual(
    tables.rows.map(({ table_name: name }) => name),
    [
      'calorie_daily_summaries',
      'calorie_intervals',
      'calorie_intervals_compact',
      'daily_health_summaries',
      'export_jobs',
      'health_archive_catalog',
      'heart_rate_daily_summaries',
      'heart_rate_samples',
      'heart_rate_samples_compact',
      'journal_entries',
      'journal_entry_revisions',
      'journal_entry_tags',
      'journal_tags',
      'schema_migrations',
      'sleep_sessions',
      'sleep_stages',
      'source_accounts',
      'source_streams',
      'sync_account_claims',
      'sync_chunks',
      'sync_jobs',
    ],
  );

  await pool.end();
});

test('migrations reject unsafe schema identifiers', async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();

  await assert.rejects(
    applyMigrations(pool, { schema: 'public; DROP SCHEMA public CASCADE' }),
    /simple PostgreSQL identifier/,
  );

  await pool.end();
});

test('lifelong archive schema uses compact semantic identities and enhanced heart statistics', async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);

  const columns = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_name IN (
      'heart_rate_samples_compact',
      'calorie_intervals_compact',
      'heart_rate_daily_summaries',
      'health_archive_catalog'
    )
  `);
  const columnsByTable = columns.rows.reduce((grouped, { table_name, column_name }) => {
    grouped[table_name] ??= [];
    grouped[table_name].push(column_name);
    return grouped;
  }, {});

  assert.deepEqual(
    new Set(columnsByTable.heart_rate_samples_compact),
    new Set([
      'source_account_id', 'source_stream_id', 'civil_date', 'sampled_at',
      'utc_offset_seconds', 'beats_per_minute', 'upstream_sample_id', 'created_at', 'updated_at',
    ]),
  );
  assert.deepEqual(
    new Set(columnsByTable.calorie_intervals_compact),
    new Set([
      'source_account_id', 'source_stream_id', 'civil_date', 'interval_type', 'start_at', 'end_at',
      'utc_offset_seconds', 'kilocalories', 'upstream_sample_id', 'created_at', 'updated_at',
    ]),
  );
  for (const column of [
    'resting_bpm', 'average_bpm', 'minimum_bpm', 'maximum_bpm', 'sample_count', 'coverage_seconds',
    'bpm_sum', 'bpm_sum_of_squares', 'population_standard_deviation_bpm',
    'p05_bpm', 'median_bpm', 'p95_bpm', 'aggregation_version', 'finalized_at',
  ]) {
    assert.ok(columnsByTable.heart_rate_daily_summaries.includes(column));
  }
  for (const column of [
    'source_account_id', 'archive_month', 'archive_version', 'is_active', 'state', 'object_key',
    'heart_sample_count', 'calorie_interval_count', 'measurement_started_at', 'measurement_ended_at', 'byte_size',
    'plaintext_hash', 'ciphertext_hash', 'encryption_key_version', 'error_code', 'error_message',
    'verified_at', 'pruned_at',
  ]) {
    assert.ok(columnsByTable.health_archive_catalog.includes(column));
  }

  await pool.end();
});

test('lifelong archive schema rejects duplicate source streams and duplicate semantic identities', async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);

  const accountId = '11111111-1111-1111-1111-111111111111';
  const streamId = '22222222-2222-2222-2222-222222222222';
  await pool.query(`INSERT INTO source_accounts (id, provider, provider_account_id) VALUES ($1, 'google', 'account')`, [accountId]);
  await pool.query(
    `INSERT INTO source_streams (id, source_account_id, metadata, metadata_hash)
     VALUES ($1, $2, '{"dataType":"heart-rate"}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
    [streamId, accountId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO source_streams (id, source_account_id, metadata, metadata_hash)
       VALUES ('33333333-3333-3333-3333-333333333333', $1, '{}', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
      [accountId],
    ),
  );

  const sampledAt = '2026-07-01T12:00:00Z';
  await pool.query(
    `INSERT INTO heart_rate_samples_compact
      (source_account_id, source_stream_id, civil_date, sampled_at, utc_offset_seconds, beats_per_minute)
     VALUES ($1, $2, '2026-07-01', $3, -14400, 70)`,
    [accountId, streamId, sampledAt],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO heart_rate_samples_compact
        (source_account_id, source_stream_id, civil_date, sampled_at, utc_offset_seconds, beats_per_minute)
       VALUES ($1, $2, '2026-07-01', $3, -14400, 71)`,
      [accountId, streamId, sampledAt],
    ),
  );

  await pool.query(
    `INSERT INTO calorie_intervals_compact
      (source_account_id, source_stream_id, civil_date, interval_type, start_at, end_at, utc_offset_seconds, kilocalories)
     VALUES ($1, $2, '2026-07-01', 'active', '2026-07-01T12:00:00Z', '2026-07-01T12:05:00Z', -14400, 10)`,
    [accountId, streamId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO calorie_intervals_compact
        (source_account_id, source_stream_id, civil_date, interval_type, start_at, end_at, utc_offset_seconds, kilocalories)
       VALUES ($1, $2, '2026-07-01', 'active', '2026-07-01T12:00:00Z', '2026-07-01T12:10:00Z', -14400, 11)`,
      [accountId, streamId],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO calorie_intervals_compact
        (source_account_id, source_stream_id, civil_date, interval_type, start_at, end_at, utc_offset_seconds, kilocalories)
       VALUES ($1, $2, '2026-07-01', 'basal', '2026-07-01T12:15:00Z', '2026-07-01T12:15:00Z', -14400, 1)`,
      [accountId, streamId],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO heart_rate_samples_compact
        (source_account_id, source_stream_id, civil_date, sampled_at, utc_offset_seconds, beats_per_minute)
       VALUES ($1, $2, '2026-07-01', '2026-07-01T13:00:00Z', -14400, 0)`,
      [accountId, streamId],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO calorie_intervals_compact
        (source_account_id, source_stream_id, civil_date, interval_type, start_at, end_at, utc_offset_seconds, kilocalories)
       VALUES ($1, $2, '2026-07-01', 'unknown', '2026-07-01T12:10:00Z', '2026-07-01T12:15:00Z', -14400, 1)`,
      [accountId, streamId],
    ),
  );

  await pool.end();
});

test('archive catalog permits superseded versions but limits each account month to one active version', async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);

  const accountId = '44444444-4444-4444-4444-444444444444';
  await pool.query(`INSERT INTO source_accounts (id, provider, provider_account_id) VALUES ($1, 'google', 'catalog-account')`, [accountId]);
  await pool.query(
    `INSERT INTO health_archive_catalog
      (id, source_account_id, archive_month, archive_version, is_active, state, object_key, heart_sample_count, calorie_interval_count)
     VALUES ('55555555-5555-5555-5555-555555555555', $1, '2026-07-01', 1, true, 'verified', 'first', 1, 1)`,
    [accountId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO health_archive_catalog
        (id, source_account_id, archive_month, archive_version, is_active, state, object_key, heart_sample_count, calorie_interval_count)
       VALUES ('66666666-6666-6666-6666-666666666666', $1, '2026-07-01', 2, true, 'verified', 'second', 1, 1)`,
      [accountId],
    ),
  );
  for (const [id, archiveMonth, archiveVersion, heartCount, calorieCount, byteSize, keyVersion] of [
    ['99999999-9999-9999-9999-999999999999', '2026-07-02', 1, 0, 0, null, null],
    ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-08-01', 0, 0, 0, null, null],
    ['bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-08-01', 1, -1, 0, null, null],
    ['cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-08-01', 1, 0, -1, null, null],
    ['dddddddd-dddd-dddd-dddd-dddddddddddd', '2026-08-01', 1, 0, 0, -1, null],
    ['eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-08-01', 1, 0, 0, null, 0],
  ]) {
    await assert.rejects(
      pool.query(
        `INSERT INTO health_archive_catalog
          (id, source_account_id, archive_month, archive_version, is_active, state,
           heart_sample_count, calorie_interval_count, byte_size, encryption_key_version)
         VALUES ($1, $2, $3, $4, false, 'failed', $5, $6, $7, $8)`,
        [id, accountId, archiveMonth, archiveVersion, heartCount, calorieCount, byteSize, keyVersion],
      ),
    );
  }
  await assert.rejects(
    pool.query(
      `INSERT INTO health_archive_catalog
        (id, source_account_id, archive_month, archive_version, is_active, state,
         heart_sample_count, calorie_interval_count, measurement_started_at, measurement_ended_at)
       VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', $1, '2026-08-01', 1, false, 'failed',
               0, 0, '2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z')`,
      [accountId],
    ),
  );
  await pool.query(
    `INSERT INTO health_archive_catalog
      (id, source_account_id, archive_month, archive_version, is_active, state, object_key, heart_sample_count, calorie_interval_count)
     VALUES ('77777777-7777-7777-7777-777777777777', $1, '2026-07-01', 2, false, 'superseded', 'second', 1, 1)`,
    [accountId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO health_archive_catalog
        (id, source_account_id, archive_month, archive_version, is_active, state, object_key, heart_sample_count, calorie_interval_count)
       VALUES ('88888888-8888-8888-8888-888888888888', $1, '2026-08-01', 1, true, 'unknown', 'bad', 0, 0)`,
      [accountId],
    ),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO heart_rate_daily_summaries
        (id, source_account_id, civil_date, aggregation_version)
       VALUES ('12121212-1212-1212-1212-121212121212', $1, '2026-08-01', 0)`,
      [accountId],
    ),
  );

  await pool.end();
});
