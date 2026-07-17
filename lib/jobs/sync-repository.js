import crypto from 'node:crypto';

function dateOnly(value) {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function jobShape(row, chunks = []) {
  const metrics = typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics;
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    priority: Number(row.priority),
    metrics,
    startDate: dateOnly(row.start_date),
    endDateExclusive: dateOnly(row.end_date_exclusive),
    requestedBy: row.requested_by,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    errorMessage: row.error_message,
    totalChunks: chunks.length,
    completedChunks: chunks.filter(({ status }) => status === 'completed').length,
    failedChunks: chunks.filter(({ status }) => status === 'failed').length,
    activeChunks: chunks.filter(({ status }) => status === 'running').length,
    queuedChunks: chunks.filter(({ status }) => status === 'queued').length,
  };
}

export function createSyncRepository(pool, { advisoryLocks = true, now = () => Date.now() } = {}) {
  async function activeJob(sourceAccountId, client = pool) {
    return (
      await client.query(
        `SELECT * FROM sync_jobs
         WHERE source_account_id = $1 AND status IN ('queued', 'running')
         ORDER BY created_at
         LIMIT 1`,
        [sourceAccountId],
      )
    ).rows[0] ?? null;
  }

  return {
    async recoverStaleClaims({ staleAfterMs = 15 * 60 * 1000 } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const recovered = await client.query(
          `UPDATE sync_chunks
           SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
             available_at = $1, updated_at = CURRENT_TIMESTAMP
           WHERE status = 'running' AND claimed_at <= $2
           RETURNING sync_job_id`,
          [new Date(now()), new Date(now() - staleAfterMs)],
        );
        const jobIds = [...new Set(recovered.rows.map(({ sync_job_id: id }) => id))];
        for (const jobId of jobIds) {
          await client.query(
            `UPDATE sync_jobs
             SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
               updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND status = 'running'`,
            [jobId],
          );
        }
        await client.query('COMMIT');
        return { chunks: recovered.rowCount, jobs: jobIds.length };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async enqueue({
      sourceAccountId,
      jobType,
      requestedBy,
      startDate,
      endDateExclusive,
      metrics,
      chunks,
      priority = 0,
    }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = await activeJob(sourceAccountId, client);
        if (existing) {
          await client.query('COMMIT');
          return jobShape(existing);
        }
        const id = crypto.randomUUID();
        const job = (
          await client.query(
            `INSERT INTO sync_jobs (
              id, source_account_id, job_type, status, priority, metrics, start_date,
              end_date_exclusive, requested_by
            ) VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
            RETURNING *`,
            [
              id,
              sourceAccountId,
              jobType,
              priority,
              JSON.stringify(metrics),
              startDate,
              endDateExclusive,
              requestedBy,
            ],
          )
        ).rows[0];
        for (const chunk of chunks) {
          await client.query(
            `INSERT INTO sync_chunks (
              id, sync_job_id, metric, operation, start_date, end_date_exclusive, page_token
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              crypto.randomUUID(),
              id,
              chunk.metric,
              chunk.operation,
              chunk.startDate,
              chunk.endDateExclusive,
              chunk.pageToken ?? null,
            ],
          );
        }
        await client.query('COMMIT');
        return jobShape(job, chunks.map(() => ({ status: 'queued' })));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async claimNextChunk(workerId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const candidate = (
          await client.query(
            `SELECT chunk.*, job.source_account_id, job.priority
             FROM sync_chunks chunk
             JOIN sync_jobs job ON job.id = chunk.sync_job_id
             WHERE chunk.status = 'queued'
               AND chunk.available_at <= $1
               AND job.status IN ('queued', 'running')
             ORDER BY job.priority DESC, chunk.created_at, chunk.id
             LIMIT 1${advisoryLocks ? ' FOR UPDATE SKIP LOCKED' : ''}`,
            [new Date(now())],
          )
        ).rows[0];
        if (!candidate) {
          await client.query('COMMIT');
          return null;
        }
        if (advisoryLocks) {
          const lock = await client.query(
            'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',
            [String(candidate.source_account_id)],
          );
          if (!lock.rows[0]?.acquired) {
            await client.query('ROLLBACK');
            return null;
          }
        }
        const claimed = (
          await client.query(
            `UPDATE sync_chunks
             SET status = 'running', claimed_by = $1, claimed_at = CURRENT_TIMESTAMP,
               attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND status = 'queued'
             RETURNING *`,
            [workerId, candidate.id],
          )
        ).rows[0];
        if (!claimed) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query(
          `UPDATE sync_jobs
           SET status = 'running', claimed_by = $1, claimed_at = CURRENT_TIMESTAMP,
             started_at = COALESCE(started_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [workerId, candidate.sync_job_id],
        );
        await client.query('COMMIT');
        return { ...claimed, source_account_id: candidate.source_account_id };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async completeChunk(chunk, { nextPageToken }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE sync_chunks
           SET status = 'completed', next_page_token = $1, completed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          [nextPageToken ?? null, chunk.id],
        );
        if (nextPageToken) {
          await client.query(
            `INSERT INTO sync_chunks (
              id, sync_job_id, metric, operation, start_date, end_date_exclusive, page_token
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (
              sync_job_id, metric, operation, start_date, end_date_exclusive, page_token
            ) DO NOTHING`,
            [
              crypto.randomUUID(),
              chunk.sync_job_id,
              chunk.metric,
              chunk.operation,
              chunk.start_date,
              chunk.end_date_exclusive,
              nextPageToken,
            ],
          );
        }
        const states = (
          await client.query(
            `SELECT status FROM sync_chunks WHERE sync_job_id = $1`,
            [chunk.sync_job_id],
          )
        ).rows;
        const pending = states.some(({ status }) => status === 'queued' || status === 'running');
        if (!pending) {
          const hasFailures = states.some(({ status }) => status === 'failed');
          await client.query(
            `UPDATE sync_jobs
             SET status = $1, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [hasFailures ? 'completed_with_errors' : 'completed', chunk.sync_job_id],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async failChunk(chunk, error, { retryable = true, maxAttempts = 4, delayMs = 0 } = {}) {
      const retry = retryable && Number(chunk.attempt_count) < maxAttempts;
      await pool.query(
        `UPDATE sync_chunks
         SET status = $1, last_error = $2, claimed_by = NULL, claimed_at = NULL,
           available_at = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [
          retry ? 'queued' : 'failed',
          String(error?.message || error).slice(0, 1000),
          new Date(now() + delayMs),
          chunk.id,
        ],
      );
      if (!retry) {
        const remaining = (
          await pool.query(
            `SELECT COUNT(*) AS count FROM sync_chunks
             WHERE sync_job_id = $1 AND status IN ('queued', 'running')`,
            [chunk.sync_job_id],
          )
        ).rows[0].count;
        if (Number(remaining) === 0) {
          await pool.query(
            `UPDATE sync_jobs
             SET status = 'completed_with_errors', finished_at = CURRENT_TIMESTAMP,
               error_message = $1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $2`,
            [String(error?.message || error).slice(0, 1000), chunk.sync_job_id],
          );
        }
      }
      return { retry };
    },

    async status() {
      const jobs = (
        await pool.query(`SELECT * FROM sync_jobs ORDER BY created_at DESC LIMIT 20`)
      ).rows;
      const shaped = [];
      for (const job of jobs) {
        const chunks = (
          await pool.query('SELECT status FROM sync_chunks WHERE sync_job_id = $1', [job.id])
        ).rows;
        shaped.push(jobShape(job, chunks));
      }
      return {
        active: shaped.filter(({ status }) => status === 'queued' || status === 'running'),
        recent: shaped,
      };
    },
  };
}
