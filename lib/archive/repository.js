import { randomUUID } from 'node:crypto';

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

    async list({ sourceAccountId, archiveMonth, state } = {}) {
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
      return (await database.query(
        `SELECT * FROM health_archive_catalog
         ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
         ORDER BY archive_month DESC, source_account_id, archive_version DESC`,
        params,
      )).rows;
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

    async pruneVerifiedMonth(id, { batchSize = 1000 } = {}) {
      const limit = positiveBatchSize(batchSize);
      const ownsClient = typeof database.connect === 'function' && typeof database.release !== 'function';
      const client = ownsClient ? await database.connect() : database;
      const removed = {
        heartRateSamples: 0,
        calorieIntervals: 0,
        compactHeartRateSamples: 0,
        compactCalorieIntervals: 0,
      };
      try {
        const catalog = await getById(id, client);
        if (!['verified', 'pruning'].includes(catalog.state) || !catalog.verified_at) {
          throw new Error('Only a verified archive month can be pruned');
        }
        await client.query(
          `UPDATE health_archive_catalog
           SET state = 'pruning', error_code = NULL, error_message = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id],
        );
        for (const [table, resultKey, identityColumns] of [
          ['heart_rate_samples_compact', 'compactHeartRateSamples', ['source_stream_id', 'sampled_at']],
          ['calorie_intervals_compact', 'compactCalorieIntervals', ['source_stream_id', 'interval_type', 'start_at']],
          ['heart_rate_samples', 'heartRateSamples', ['id']],
          ['calorie_intervals', 'calorieIntervals', ['id']],
        ]) {
          const selectedIdentity = identityColumns.map((column) => `raw.${column}`).join(', ');
          const identityJoin = identityColumns
            .map((column) => `raw.${column} = doomed.${column}`).join(' AND ');
          for (;;) {
            await client.query('BEGIN');
            try {
              const result = await client.query(
                `WITH authorized AS (
                   SELECT source_account_id, archive_month
                   FROM health_archive_catalog
                   WHERE id = $1 AND is_active = true AND state = 'pruning'
                     AND verified_at IS NOT NULL
                 ), doomed AS (
                   SELECT ${selectedIdentity}
                   FROM ${table} AS raw
                   JOIN authorized AS archive
                     ON archive.source_account_id = raw.source_account_id
                    AND raw.civil_date >= archive.archive_month
                    AND raw.civil_date < archive.archive_month + INTERVAL '1 month'
                   ORDER BY ${selectedIdentity}
                   LIMIT $2
                 )
                 DELETE FROM ${table} AS raw
                 USING doomed
                 WHERE ${identityJoin}
                 RETURNING raw.${identityColumns[0]}`,
                [id, limit],
              );
              await client.query('COMMIT');
              removed[resultKey] += result.rowCount;
              if (result.rowCount < limit) break;
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            }
          }
        }
        await client.query(
          `UPDATE health_archive_catalog
           SET state = 'pruned', pruned_at = COALESCE(pruned_at, CURRENT_TIMESTAMP),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = 'pruning'`,
          [id],
        );
        return removed;
      } catch (error) {
        await client.query(
          `UPDATE health_archive_catalog
           SET error_code = 'ARCHIVE_PRUNE_FAILED',
               error_message = 'Health archive prune failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = 'pruning'`,
          [id],
        ).catch(() => {});
        throw error;
      } finally {
        if (ownsClient) client.release();
      }
    },
  };
}
