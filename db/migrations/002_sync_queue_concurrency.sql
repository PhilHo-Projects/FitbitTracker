CREATE UNIQUE INDEX sync_jobs_one_active_per_account_idx
  ON sync_jobs (source_account_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE sync_account_claims (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  sync_chunk_id uuid NOT NULL UNIQUE REFERENCES sync_chunks(id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sync_account_claims (source_account_id, sync_chunk_id)
SELECT job.source_account_id, chunk.id
FROM sync_chunks AS chunk
JOIN sync_jobs AS job ON job.id = chunk.sync_job_id
WHERE chunk.status = 'running'
ON CONFLICT DO NOTHING;
