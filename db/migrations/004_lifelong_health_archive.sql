CREATE TABLE source_streams (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  metadata jsonb NOT NULL,
  metadata_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, metadata_hash),
  UNIQUE (id, source_account_id)
);

CREATE TABLE heart_rate_samples_compact (
  source_account_id uuid NOT NULL,
  source_stream_id uuid NOT NULL,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL,
  utc_offset_seconds integer,
  beats_per_minute numeric(7, 2) NOT NULL CHECK (beats_per_minute > 0),
  upstream_sample_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_stream_id, sampled_at),
  FOREIGN KEY (source_stream_id, source_account_id)
    REFERENCES source_streams (id, source_account_id) ON DELETE CASCADE
);

CREATE INDEX heart_rate_samples_compact_access_idx
  ON heart_rate_samples_compact (source_account_id, civil_date, sampled_at)
  INCLUDE (source_stream_id, utc_offset_seconds, beats_per_minute, upstream_sample_id);

CREATE TABLE calorie_intervals_compact (
  source_account_id uuid NOT NULL,
  source_stream_id uuid NOT NULL,
  civil_date date NOT NULL,
  interval_type text NOT NULL CHECK (interval_type IN ('total', 'active', 'basal')),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL CHECK (end_at > start_at),
  utc_offset_seconds integer,
  kilocalories numeric(12, 4) NOT NULL,
  upstream_sample_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_stream_id, interval_type, start_at),
  FOREIGN KEY (source_stream_id, source_account_id)
    REFERENCES source_streams (id, source_account_id) ON DELETE CASCADE
);

ALTER TABLE heart_rate_daily_summaries
  ADD COLUMN bpm_sum numeric(16, 2),
  ADD COLUMN bpm_sum_of_squares numeric(20, 4),
  ADD COLUMN population_standard_deviation_bpm numeric(7, 2),
  ADD COLUMN p05_bpm numeric(7, 2),
  ADD COLUMN median_bpm numeric(7, 2),
  ADD COLUMN p95_bpm numeric(7, 2),
  ADD COLUMN aggregation_version integer NOT NULL DEFAULT 1 CHECK (aggregation_version > 0),
  ADD COLUMN finalized_at timestamptz;

CREATE TABLE health_archive_catalog (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  archive_month date NOT NULL,
  archive_version integer NOT NULL CHECK (archive_version > 0),
  is_active boolean NOT NULL DEFAULT true,
  state text NOT NULL CHECK (state IN (
    'pending', 'building', 'uploaded', 'verified', 'pruning', 'pruned', 'failed', 'superseded'
  )),
  object_key text,
  heart_sample_count bigint NOT NULL DEFAULT 0 CHECK (heart_sample_count >= 0),
  calorie_interval_count bigint NOT NULL DEFAULT 0 CHECK (calorie_interval_count >= 0),
  measurement_started_at timestamptz,
  measurement_ended_at timestamptz,
  byte_size bigint CHECK (byte_size >= 0),
  plaintext_hash char(64),
  ciphertext_hash char(64),
  encryption_key_version integer CHECK (encryption_key_version > 0),
  error_code text,
  error_message text,
  verified_at timestamptz,
  pruned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, archive_month, archive_version),
  CHECK (measurement_ended_at IS NULL OR measurement_started_at IS NULL OR measurement_ended_at >= measurement_started_at)
);

CREATE UNIQUE INDEX health_archive_catalog_one_active_month_idx
  ON health_archive_catalog (source_account_id, archive_month)
  WHERE is_active;
