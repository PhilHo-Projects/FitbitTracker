import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import { applyMigrations } from '../lib/db/migrations.js';

const integrationUrl = process.env.PG_INTEGRATION_URL;

test('PostgreSQL integration applies the lifelong archive schema and constraints', { skip: !integrationUrl }, async () => {
  const pool = new pg.Pool({ connectionString: integrationUrl });

  try {
    // PG_INTEGRATION_URL must identify a disposable database. Resetting public keeps
    // each integration run independent while leaving normal local tests untouched.
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await applyMigrations(pool);

    const version = await pool.query('SHOW server_version_num');
    assert.ok(Number(version.rows[0].server_version_num) >= 160000);

    const index = await pool.query(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'heart_rate_samples_compact_access_idx'
    `);
    assert.match(index.rows[0].indexdef, /INCLUDE \(source_stream_id, utc_offset_seconds, beats_per_minute, upstream_sample_id\)/);

    const accountId = '11111111-1111-1111-1111-111111111111';
    const streamId = '22222222-2222-2222-2222-222222222222';
    await pool.query(
      `INSERT INTO source_accounts (id, provider, provider_account_id) VALUES ($1, 'google', 'integration-account')`,
      [accountId],
    );
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
      { code: '23505' },
    );

    await pool.query(
      `INSERT INTO heart_rate_samples_compact
        (source_account_id, source_stream_id, civil_date, sampled_at, utc_offset_seconds, beats_per_minute)
       VALUES ($1, $2, '2026-07-01', '2026-07-01T12:00:00Z', -14400, 70)`,
      [accountId, streamId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO heart_rate_samples_compact
          (source_account_id, source_stream_id, civil_date, sampled_at, utc_offset_seconds, beats_per_minute)
         VALUES ($1, $2, '2026-07-01', '2026-07-01T12:00:00Z', -14400, 71)`,
        [accountId, streamId],
      ),
      { code: '23505' },
    );

    await pool.query(
      `INSERT INTO calorie_intervals_compact
        (source_account_id, source_stream_id, civil_date, interval_type, start_at, end_at, utc_offset_seconds, kilocalories)
       VALUES ($1, $2, '2026-07-01', 'active', '2026-07-01T12:00:00Z', '2026-07-01T12:05:00Z', -14400, 10)`,
      [accountId, streamId],
    );
    await pool.query(
      `UPDATE calorie_intervals_compact
       SET end_at = '2026-07-01T12:10:00Z', kilocalories = 11
       WHERE source_stream_id = $1
         AND interval_type = 'active'
         AND start_at = '2026-07-01T12:00:00Z'`,
      [streamId],
    );
    const correctedInterval = await pool.query(
      `SELECT end_at, kilocalories
       FROM calorie_intervals_compact
       WHERE source_stream_id = $1`,
      [streamId],
    );
    assert.equal(correctedInterval.rows[0].end_at.toISOString(), '2026-07-01T12:10:00.000Z');
    assert.equal(Number(correctedInterval.rows[0].kilocalories), 11);

    await pool.query(
      `INSERT INTO health_archive_catalog
        (id, source_account_id, archive_month, archive_version, is_active, state, heart_sample_count, calorie_interval_count)
       VALUES ('44444444-4444-4444-4444-444444444444', $1, '2026-07-01', 1, true, 'verified', 1, 1)`,
      [accountId],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO health_archive_catalog
          (id, source_account_id, archive_month, archive_version, is_active, state, heart_sample_count, calorie_interval_count)
         VALUES ('55555555-5555-5555-5555-555555555555', $1, '2026-07-01', 2, true, 'verified', 1, 1)`,
        [accountId],
      ),
      { code: '23505' },
    );
    await pool.query(
      `INSERT INTO health_archive_catalog
        (id, source_account_id, archive_month, archive_version, is_active, state, heart_sample_count, calorie_interval_count)
       VALUES ('66666666-6666-6666-6666-666666666666', $1, '2026-07-01', 2, false, 'superseded', 1, 1)`,
      [accountId],
    );
  } finally {
    await pool.end();
  }
});
