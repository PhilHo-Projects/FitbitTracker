import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ARCHIVE_SCHEMAS } from './bundle.js';
import { readCsvRows } from './csv.js';

function civilDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function positiveBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw new Error('Archive prune batch size must be between 1 and 100000');
  }
  return parsed;
}

function positiveListLimit(value = 50) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('Archive catalog limit must be between 1 and 100');
  }
  return parsed;
}

function encodeListCursor(row) {
  return Buffer.from(JSON.stringify({
    month: civilDate(row.archive_month),
    account: row.source_account_id,
    version: Number(row.archive_version),
    id: row.id,
  })).toString('base64url');
}

function decodeListCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(decoded.month)
      || typeof decoded.account !== 'string'
      || !decoded.account
      || !Number.isInteger(decoded.version)
      || decoded.version < 1
      || typeof decoded.id !== 'string'
      || !decoded.id
    ) throw new Error('invalid');
    return decoded;
  } catch {
    throw new Error('Invalid archive catalog cursor');
  }
}

function assertSafeFailure({ errorCode, errorMessage }) {
  const match = /^ARCHIVE_(BUILD|UPLOAD|VERIFY|PRUNE|OPERATION)_FAILED$/.exec(errorCode || '');
  const expected = match && `Health archive ${match[1].toLowerCase()} failed`;
  if (!match || errorMessage !== expected) {
    throw new Error('Catalog failures require safe archive error metadata');
  }
}

async function withTransaction(database, operation) {
  const ownsClient = typeof database.connect === 'function' && typeof database.release !== 'function';
  const client = ownsClient ? await database.connect() : database;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

function archiveCell(value) {
  return value === '\\N' ? null : value;
}

async function loadArchiveCsvStage({
  client,
  filePath,
  expectedSchema,
  table,
  columns,
  batchSize,
}) {
  let headerSeen = false;
  let count = 0;
  let rows = [];
  async function insertRows() {
    if (!rows.length) return;
    const params = rows.flat();
    const values = rows.map((row, rowIndex) =>
      `(${row.map((_value, columnIndex) =>
        `$${rowIndex * columns.length + columnIndex + 1}`).join(', ')})`).join(', ');
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values}`,
      params,
    );
    rows = [];
  }
  for await (const row of readCsvRows(filePath)) {
    if (!headerSeen) {
      if (JSON.stringify(row) !== JSON.stringify(expectedSchema)) {
        throw new Error('Archive CSV schema mismatch during prune staging');
      }
      headerSeen = true;
      continue;
    }
    if (row.length !== columns.length) {
      throw new Error('Archive CSV row schema mismatch during prune staging');
    }
    rows.push(row.map(archiveCell));
    count += 1;
    if (rows.length >= batchSize) await insertRows();
  }
  if (!headerSeen) throw new Error('Archive CSV is missing its header');
  await insertRows();
  return count;
}

export function createHealthArchiveRepository(database, { advisoryLocks = true } = {}) {
  if (!database) throw new Error('Health archive repository requires a database');

  async function getById(id, queryable = database) {
    const result = await queryable.query(
      'SELECT * FROM health_archive_catalog WHERE id = $1',
      [id],
    );
    if (!result.rows.length) throw new Error('Health archive catalog entry not found');
    return result.rows[0];
  }

  async function reserveMonth(sourceAccountId, archiveMonth) {
    return withTransaction(database, async (client) => {
      let active = (await client.query(
        `SELECT * FROM health_archive_catalog
         WHERE source_account_id = $1 AND archive_month = $2::date AND is_active = true
         FOR UPDATE`,
        [sourceAccountId, archiveMonth],
      )).rows[0];
      if (active && active.state !== 'failed') return active;
      if (active) {
        await client.query(
          `UPDATE health_archive_catalog
           SET is_active = false, state = 'superseded', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [active.id],
        );
      }
      const version = Number((await client.query(
        `SELECT COALESCE(MAX(archive_version), 0) + 1 AS version
         FROM health_archive_catalog
         WHERE source_account_id = $1 AND archive_month = $2::date`,
        [sourceAccountId, archiveMonth],
      )).rows[0].version);
      active = (await client.query(
        `INSERT INTO health_archive_catalog (
           id, source_account_id, archive_month, archive_version, is_active, state
         ) VALUES ($1, $2, $3::date, $4, true, 'pending')
         RETURNING *`,
        [randomUUID(), sourceAccountId, archiveMonth, version],
      )).rows[0];
      return active;
    });
  }

  async function updateAndReturn(sql, params) {
    const result = await database.query(sql, params);
    if (!result.rows.length) throw new Error('Invalid health archive catalog state transition');
    return result.rows[0];
  }

  return {
    async withMonthLock(sourceAccountId, archiveMonth, operation) {
      const ownsClient = typeof database.connect === 'function' && typeof database.release !== 'function';
      const client = ownsClient ? await database.connect() : database;
      const lockKey = `${sourceAccountId}:${civilDate(archiveMonth)}`;
      const useLock = advisoryLocks && database.constructor?.name !== 'MemPg';
      try {
        if (useLock) await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
        const scoped = createHealthArchiveRepository(client, { advisoryLocks: false });
        return await operation(scoped);
      } finally {
        if (useLock) {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
            .catch(() => {});
        }
        if (ownsClient) client.release();
      }
    },

    reserveMonth,
    getById,

    async list({ sourceAccountId, archiveMonth, state, limit = 50, cursor } = {}) {
      const pageLimit = positiveListLimit(limit);
      const params = [];
      const predicates = [];
      if (sourceAccountId) {
        params.push(sourceAccountId);
        predicates.push(`source_account_id = $${params.length}`);
      }
      if (archiveMonth) {
        params.push(archiveMonth);
        predicates.push(`archive_month = $${params.length}::date`);
      }
      if (state) {
        params.push(state);
        predicates.push(`state = $${params.length}`);
      }
      if (cursor) {
        const decoded = decodeListCursor(cursor);
        params.push(decoded.month, decoded.account, decoded.version, decoded.id);
        const position = params.length - 3;
        predicates.push(`(
          archive_month < $${position}::date
          OR (archive_month = $${position}::date AND source_account_id > $${position + 1})
          OR (archive_month = $${position}::date AND source_account_id = $${position + 1}
              AND archive_version < $${position + 2})
          OR (archive_month = $${position}::date AND source_account_id = $${position + 1}
              AND archive_version = $${position + 2} AND id > $${position + 3})
        )`);
      }
      params.push(pageLimit + 1);
      const rows = (await database.query(
        `SELECT * FROM health_archive_catalog
         ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
         ORDER BY archive_month DESC, source_account_id ASC, archive_version DESC, id ASC
         LIMIT $${params.length}`,
        params,
      )).rows;
      const hasMore = rows.length > pageLimit;
      const items = hasMore ? rows.slice(0, pageLimit) : rows;
      return {
        items,
        nextCursor: hasMore ? encodeListCursor(items.at(-1)) : null,
      };
    },

    async listEligibleMonths({ today = new Date().toISOString().slice(0, 10), retentionDays = 90 } = {}) {
      return (await database.query(
        `WITH months AS (
           SELECT DISTINCT source_account_id, DATE_TRUNC('month', civil_date)::date AS archive_month
           FROM heart_rate_samples_compact
           UNION
           SELECT DISTINCT source_account_id, DATE_TRUNC('month', civil_date)::date AS archive_month
           FROM calorie_intervals_compact
         )
         SELECT months.source_account_id, months.archive_month
         FROM months
         WHERE (months.archive_month + INTERVAL '1 month' - INTERVAL '1 day')::date
                 <= $1::date - $2::integer
           AND NOT EXISTS (
             SELECT 1 FROM health_archive_catalog AS archive
             WHERE archive.source_account_id = months.source_account_id
               AND archive.archive_month = months.archive_month
               AND archive.is_active = true
               AND archive.state IN ('verified', 'pruning', 'pruned')
           )
         ORDER BY months.archive_month, months.source_account_id`,
        [today, retentionDays],
      )).rows;
    },

    markBuilding(id) {
      return updateAndReturn(
        `UPDATE health_archive_catalog
         SET state = 'building', error_code = NULL, error_message = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state IN ('pending', 'building')
         RETURNING *`,
        [id],
      );
    },

    recordBuilt(id, built) {
      return updateAndReturn(
        `UPDATE health_archive_catalog
         SET object_key = $2,
             heart_sample_count = $3,
             calorie_interval_count = $4,
             measurement_started_at = $5,
             measurement_ended_at = $6,
             byte_size = $7,
             plaintext_hash = $8,
             ciphertext_hash = $9,
             encryption_key_version = $10,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state = 'building'
         RETURNING *`,
        [
          id,
          built.objectKey,
          built.heartSampleCount,
          built.calorieIntervalCount,
          built.measurementStartedAt,
          built.measurementEndedAt,
          built.byteSize,
          built.plaintextHash,
          built.ciphertextHash,
          built.encryptionKeyVersion,
        ],
      );
    },

    markUploaded(id) {
      return updateAndReturn(
        `UPDATE health_archive_catalog
         SET state = 'uploaded', updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state IN ('building', 'uploaded') AND object_key IS NOT NULL
         RETURNING *`,
        [id],
      );
    },

    markVerified(id) {
      return updateAndReturn(
        `UPDATE health_archive_catalog
         SET state = 'verified', verified_at = COALESCE(verified_at, CURRENT_TIMESTAMP),
             error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state IN ('building', 'uploaded', 'verified')
           AND object_key IS NOT NULL AND ciphertext_hash IS NOT NULL
         RETURNING *`,
        [id],
      );
    },

    async recordFailure(id, failure) {
      assertSafeFailure(failure);
      return updateAndReturn(
        `UPDATE health_archive_catalog
         SET state = 'failed', error_code = $2, error_message = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state NOT IN ('pruning', 'pruned', 'superseded')
         RETURNING *`,
        [id, failure.errorCode, failure.errorMessage],
      );
    },

    async recordVerificationFailure(id, failure) {
      assertSafeFailure(failure);
      return updateAndReturn(
        `UPDATE health_archive_catalog
         SET state = CASE WHEN state IN ('pruning', 'pruned') THEN state ELSE 'failed' END,
             error_code = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state <> 'superseded'
         RETURNING *`,
        [id, failure.errorCode, failure.errorMessage],
      );
    },

    async pruneVerifiedMonth(id, { batchSize = 1000, archiveDirectory } = {}) {
      const limit = positiveBatchSize(batchSize);
      if (!archiveDirectory) throw new Error('Archive prune requires a validated extraction directory');
      const ownsClient = typeof database.connect === 'function' && typeof database.release !== 'function';
      const client = ownsClient ? await database.connect() : database;
      const removed = {
        compactHeartRateSamples: 0,
        compactCalorieIntervals: 0,
      };
      try {
        const catalog = await getById(id, client);
        if (catalog.is_active !== true || !['verified', 'pruning'].includes(catalog.state) || !catalog.verified_at) {
          throw new Error('Only a verified archive month can be pruned');
        }
        await client.query(`DROP TABLE IF EXISTS pg_temp.health_archive_prune_heart_stage`);
        await client.query(`DROP TABLE IF EXISTS pg_temp.health_archive_prune_calorie_stage`);
        await client.query(
          `CREATE TEMP TABLE health_archive_prune_heart_stage (
             source_stream_id uuid NOT NULL,
             civil_date date NOT NULL,
             sampled_at timestamptz NOT NULL,
             utc_offset_seconds integer,
             beats_per_minute numeric(7, 2) NOT NULL,
             upstream_sample_id text,
             PRIMARY KEY (source_stream_id, sampled_at)
           ) ON COMMIT PRESERVE ROWS`,
        );
        await client.query(
          `CREATE TEMP TABLE health_archive_prune_calorie_stage (
             source_stream_id uuid NOT NULL,
             civil_date date NOT NULL,
             interval_type text NOT NULL,
             start_at timestamptz NOT NULL,
             end_at timestamptz NOT NULL,
             utc_offset_seconds integer,
             kilocalories numeric(12, 4) NOT NULL,
             upstream_sample_id text,
             PRIMARY KEY (source_stream_id, interval_type, start_at)
           ) ON COMMIT PRESERVE ROWS`,
        );
        const heartCount = await loadArchiveCsvStage({
          client,
          filePath: path.join(archiveDirectory, 'heart-rate-samples.csv'),
          expectedSchema: ARCHIVE_SCHEMAS['heart-rate-samples.csv'],
          table: 'health_archive_prune_heart_stage',
          columns: ARCHIVE_SCHEMAS['heart-rate-samples.csv'],
          batchSize: Math.min(limit, 5000),
        });
        const calorieCount = await loadArchiveCsvStage({
          client,
          filePath: path.join(archiveDirectory, 'calorie-intervals.csv'),
          expectedSchema: ARCHIVE_SCHEMAS['calorie-intervals.csv'],
          table: 'health_archive_prune_calorie_stage',
          columns: ARCHIVE_SCHEMAS['calorie-intervals.csv'],
          batchSize: Math.min(limit, 5000),
        });
        if (
          heartCount !== Number(catalog.heart_sample_count)
          || calorieCount !== Number(catalog.calorie_interval_count)
        ) throw new Error('Archive staged row count does not match catalog');

        const preflight = (await client.query(
          `WITH authorized AS (
             SELECT source_account_id, archive_month
             FROM health_archive_catalog
             WHERE id = $1 AND is_active = true AND state IN ('verified', 'pruning')
               AND verified_at IS NOT NULL
           )
           SELECT
             EXISTS (
               SELECT 1
               FROM heart_rate_samples_compact AS raw
               JOIN authorized AS archive
                 ON archive.source_account_id = raw.source_account_id
                AND raw.civil_date >= archive.archive_month
                AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
               WHERE NOT EXISTS (
                 SELECT 1 FROM health_archive_prune_heart_stage AS staged
                 WHERE staged.source_stream_id = raw.source_stream_id
                   AND staged.civil_date IS NOT DISTINCT FROM raw.civil_date
                   AND staged.sampled_at IS NOT DISTINCT FROM raw.sampled_at
                   AND staged.utc_offset_seconds IS NOT DISTINCT FROM raw.utc_offset_seconds
                   AND staged.beats_per_minute IS NOT DISTINCT FROM raw.beats_per_minute
                   AND staged.upstream_sample_id IS NOT DISTINCT FROM raw.upstream_sample_id
               )
             ) AS heart_mismatch,
             EXISTS (
               SELECT 1
               FROM calorie_intervals_compact AS raw
               JOIN authorized AS archive
                 ON archive.source_account_id = raw.source_account_id
                AND raw.civil_date >= archive.archive_month
                AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
               WHERE NOT EXISTS (
                 SELECT 1 FROM health_archive_prune_calorie_stage AS staged
                 WHERE staged.source_stream_id = raw.source_stream_id
                   AND staged.civil_date IS NOT DISTINCT FROM raw.civil_date
                   AND staged.interval_type IS NOT DISTINCT FROM raw.interval_type
                   AND staged.start_at IS NOT DISTINCT FROM raw.start_at
                   AND staged.end_at IS NOT DISTINCT FROM raw.end_at
                   AND staged.utc_offset_seconds IS NOT DISTINCT FROM raw.utc_offset_seconds
                   AND staged.kilocalories IS NOT DISTINCT FROM raw.kilocalories
                   AND staged.upstream_sample_id IS NOT DISTINCT FROM raw.upstream_sample_id
               )
             ) AS calorie_mismatch`,
          [id],
        )).rows[0];
        if (preflight?.heart_mismatch || preflight?.calorie_mismatch) {
          throw new Error('Current compact rows do not exactly match the verified archive');
        }

        const pruningTransition = await client.query(
          `UPDATE health_archive_catalog
           SET state = 'pruning', error_code = NULL, error_message = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND is_active = true AND state IN ('verified', 'pruning')
             AND verified_at IS NOT NULL`,
          [id],
        );
        if (pruningTransition.rowCount !== 1) {
          throw new Error('Archive catalog changed during prune preflight');
        }

        for (const [sql, resultKey] of [
          [`WITH authorized AS (
              SELECT source_account_id, archive_month
              FROM health_archive_catalog
              WHERE id = $1 AND is_active = true AND state = 'pruning'
                AND verified_at IS NOT NULL
            ), doomed AS (
              SELECT raw.source_stream_id, raw.sampled_at
              FROM heart_rate_samples_compact AS raw
              JOIN authorized AS archive
                ON archive.source_account_id = raw.source_account_id
               AND raw.civil_date >= archive.archive_month
               AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
              JOIN health_archive_prune_heart_stage AS staged
                ON staged.source_stream_id = raw.source_stream_id
               AND staged.civil_date IS NOT DISTINCT FROM raw.civil_date
               AND staged.sampled_at IS NOT DISTINCT FROM raw.sampled_at
               AND staged.utc_offset_seconds IS NOT DISTINCT FROM raw.utc_offset_seconds
               AND staged.beats_per_minute IS NOT DISTINCT FROM raw.beats_per_minute
               AND staged.upstream_sample_id IS NOT DISTINCT FROM raw.upstream_sample_id
              ORDER BY raw.sampled_at, raw.source_stream_id
              LIMIT $2
            )
            DELETE FROM heart_rate_samples_compact AS raw
            USING doomed, health_archive_prune_heart_stage AS staged
            WHERE raw.source_stream_id = doomed.source_stream_id
              AND raw.sampled_at = doomed.sampled_at
              AND staged.source_stream_id = raw.source_stream_id
              AND staged.civil_date IS NOT DISTINCT FROM raw.civil_date
              AND staged.sampled_at IS NOT DISTINCT FROM raw.sampled_at
              AND staged.utc_offset_seconds IS NOT DISTINCT FROM raw.utc_offset_seconds
              AND staged.beats_per_minute IS NOT DISTINCT FROM raw.beats_per_minute
              AND staged.upstream_sample_id IS NOT DISTINCT FROM raw.upstream_sample_id
            RETURNING raw.source_stream_id`, 'compactHeartRateSamples'],
          [`WITH authorized AS (
              SELECT source_account_id, archive_month
              FROM health_archive_catalog
              WHERE id = $1 AND is_active = true AND state = 'pruning'
                AND verified_at IS NOT NULL
            ), doomed AS (
              SELECT raw.source_stream_id, raw.interval_type, raw.start_at
              FROM calorie_intervals_compact AS raw
              JOIN authorized AS archive
                ON archive.source_account_id = raw.source_account_id
               AND raw.civil_date >= archive.archive_month
               AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
              JOIN health_archive_prune_calorie_stage AS staged
                ON staged.source_stream_id = raw.source_stream_id
               AND staged.civil_date IS NOT DISTINCT FROM raw.civil_date
               AND staged.interval_type IS NOT DISTINCT FROM raw.interval_type
               AND staged.start_at IS NOT DISTINCT FROM raw.start_at
               AND staged.end_at IS NOT DISTINCT FROM raw.end_at
               AND staged.utc_offset_seconds IS NOT DISTINCT FROM raw.utc_offset_seconds
               AND staged.kilocalories IS NOT DISTINCT FROM raw.kilocalories
               AND staged.upstream_sample_id IS NOT DISTINCT FROM raw.upstream_sample_id
              ORDER BY raw.start_at, raw.interval_type, raw.source_stream_id
              LIMIT $2
            )
            DELETE FROM calorie_intervals_compact AS raw
            USING doomed, health_archive_prune_calorie_stage AS staged
            WHERE raw.source_stream_id = doomed.source_stream_id
              AND raw.interval_type = doomed.interval_type
              AND raw.start_at = doomed.start_at
              AND staged.source_stream_id = raw.source_stream_id
              AND staged.civil_date IS NOT DISTINCT FROM raw.civil_date
              AND staged.interval_type IS NOT DISTINCT FROM raw.interval_type
              AND staged.start_at IS NOT DISTINCT FROM raw.start_at
              AND staged.end_at IS NOT DISTINCT FROM raw.end_at
              AND staged.utc_offset_seconds IS NOT DISTINCT FROM raw.utc_offset_seconds
              AND staged.kilocalories IS NOT DISTINCT FROM raw.kilocalories
              AND staged.upstream_sample_id IS NOT DISTINCT FROM raw.upstream_sample_id
            RETURNING raw.source_stream_id`, 'compactCalorieIntervals'],
        ]) {
          for (;;) {
            await client.query('BEGIN');
            try {
              const result = await client.query(sql, [id, limit]);
              await client.query('COMMIT');
              removed[resultKey] += result.rowCount;
              if (result.rowCount < limit) break;
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            }
          }
        }

        await client.query('BEGIN');
        try {
          await client.query(
            `LOCK TABLE heart_rate_samples_compact, calorie_intervals_compact
             IN SHARE ROW EXCLUSIVE MODE`,
          );
          const remaining = (await client.query(
            `WITH authorized AS (
               SELECT source_account_id, archive_month
               FROM health_archive_catalog
               WHERE id = $1 AND is_active = true AND state = 'pruning'
                 AND verified_at IS NOT NULL
             )
             SELECT
               (SELECT COUNT(*) FROM heart_rate_samples_compact AS raw
                JOIN authorized AS archive ON archive.source_account_id = raw.source_account_id
                 AND raw.civil_date >= archive.archive_month
                 AND raw.civil_date < archive.archive_month + INTERVAL '1 month') AS heart_count,
               (SELECT COUNT(*) FROM calorie_intervals_compact AS raw
                JOIN authorized AS archive ON archive.source_account_id = raw.source_account_id
                 AND raw.civil_date >= archive.archive_month
                 AND raw.civil_date < archive.archive_month + INTERVAL '1 month') AS calorie_count`,
            [id],
          )).rows[0];
          if (Number(remaining?.heart_count) || Number(remaining?.calorie_count)) {
            throw new Error('Compact rows remain after archive prune');
          }
          const prunedTransition = await client.query(
            `UPDATE health_archive_catalog
             SET state = 'pruned', pruned_at = COALESCE(pruned_at, CURRENT_TIMESTAMP),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND is_active = true AND state = 'pruning'
               AND verified_at IS NOT NULL`,
            [id],
          );
          if (prunedTransition.rowCount !== 1) {
            throw new Error('Archive catalog changed before prune completion');
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
        return removed;
      } catch (error) {
        await client.query(
          `UPDATE health_archive_catalog
           SET error_code = 'ARCHIVE_PRUNE_FAILED',
               error_message = 'Health archive prune failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state IN ('verified', 'pruning')`,
          [id],
        ).catch(() => {});
        throw error;
      } finally {
        await client.query(`DROP TABLE IF EXISTS pg_temp.health_archive_prune_heart_stage`).catch(() => {});
        await client.query(`DROP TABLE IF EXISTS pg_temp.health_archive_prune_calorie_stage`).catch(() => {});
        if (ownsClient) client.release();
      }
    },
  };
}
