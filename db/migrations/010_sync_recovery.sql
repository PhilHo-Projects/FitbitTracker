ALTER TABLE sync_jobs ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX sync_jobs_recovery_identity ON sync_jobs(source_account_id, dedupe_key);
ALTER TABLE sync_chunks ADD COLUMN error_code text;
ALTER TABLE sync_chunks ADD COLUMN http_status integer;
ALTER TABLE connector_credentials ADD COLUMN connection_generation uuid;
ALTER TABLE connector_credentials ADD COLUMN recovery_from timestamptz;
ALTER TABLE connector_credentials ADD COLUMN recovery_pending boolean NOT NULL DEFAULT false;
ALTER TABLE oxygen_saturation_samples ALTER COLUMN provider_id DROP NOT NULL;
ALTER TABLE oxygen_saturation_daily_summaries ALTER COLUMN provider_id DROP NOT NULL;
