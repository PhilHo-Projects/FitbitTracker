CREATE TABLE source_accounts (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  display_name text,
  timezone text NOT NULL DEFAULT 'America/Toronto',
  membership_start_date date,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE sleep_sessions (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  civil_date date NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  start_offset_seconds integer,
  end_offset_seconds integer,
  sleep_type text NOT NULL,
  is_nap boolean NOT NULL DEFAULT false,
  duration_seconds integer NOT NULL,
  asleep_seconds integer,
  awake_seconds integer,
  efficiency numeric(6, 2),
  time_to_sleep_seconds integer,
  awake_episodes integer,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, provider_key)
);

CREATE INDEX sleep_sessions_date_idx ON sleep_sessions (source_account_id, civil_date DESC);

CREATE TABLE sleep_stages (
  id uuid PRIMARY KEY,
  sleep_session_id uuid NOT NULL REFERENCES sleep_sessions(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  sequence integer NOT NULL,
  stage_type text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  duration_seconds integer NOT NULL,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (sleep_session_id, provider_key)
);

CREATE INDEX sleep_stages_time_idx ON sleep_stages (sleep_session_id, start_time);

CREATE TABLE heart_rate_samples (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL,
  utc_offset_seconds integer,
  beats_per_minute numeric(7, 2) NOT NULL,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, provider_key)
);

CREATE INDEX heart_rate_samples_time_idx ON heart_rate_samples (source_account_id, sampled_at);
CREATE INDEX heart_rate_samples_date_idx ON heart_rate_samples (source_account_id, civil_date);

CREATE TABLE heart_rate_daily_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  civil_date date NOT NULL,
  resting_bpm numeric(7, 2),
  average_bpm numeric(7, 2),
  minimum_bpm numeric(7, 2),
  maximum_bpm numeric(7, 2),
  sample_count integer NOT NULL DEFAULT 0,
  coverage_seconds integer NOT NULL DEFAULT 0,
  resting_derived boolean NOT NULL DEFAULT false,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, civil_date)
);

CREATE TABLE calorie_intervals (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  civil_date date NOT NULL,
  metric_type text NOT NULL CHECK (metric_type IN ('total', 'active', 'basal')),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  utc_offset_seconds integer,
  kilocalories numeric(12, 4) NOT NULL,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, provider_key)
);

CREATE INDEX calorie_intervals_time_idx ON calorie_intervals (source_account_id, start_time);
CREATE INDEX calorie_intervals_date_idx ON calorie_intervals (source_account_id, civil_date, metric_type);

CREATE TABLE calorie_daily_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  civil_date date NOT NULL,
  total_kcal numeric(12, 2),
  active_kcal numeric(12, 2),
  basal_kcal numeric(12, 2),
  interval_count integer NOT NULL DEFAULT 0,
  coverage_seconds integer NOT NULL DEFAULT 0,
  total_derived boolean NOT NULL DEFAULT false,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, civil_date)
);

CREATE TABLE daily_health_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  civil_date date NOT NULL,
  sleep_session_id uuid REFERENCES sleep_sessions(id) ON DELETE SET NULL,
  sleep_duration_seconds integer,
  sleep_asleep_seconds integer,
  sleep_awake_seconds integer,
  sleep_efficiency numeric(6, 2),
  heart_resting_bpm numeric(7, 2),
  heart_average_bpm numeric(7, 2),
  heart_minimum_bpm numeric(7, 2),
  heart_maximum_bpm numeric(7, 2),
  heart_sample_count integer,
  calorie_total_kcal numeric(12, 2),
  calorie_active_kcal numeric(12, 2),
  calorie_basal_kcal numeric(12, 2),
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  derivations jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, civil_date)
);

CREATE INDEX daily_health_summaries_date_idx
  ON daily_health_summaries (source_account_id, civil_date DESC);

CREATE TABLE sync_jobs (
  id uuid PRIMARY KEY,
  source_account_id uuid REFERENCES source_accounts(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  priority integer NOT NULL DEFAULT 0,
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  start_date date,
  end_date_exclusive date,
  requested_by text NOT NULL DEFAULT 'system',
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX sync_jobs_claim_idx ON sync_jobs (status, priority DESC, created_at);

CREATE TABLE sync_chunks (
  id uuid PRIMARY KEY,
  sync_job_id uuid NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  metric text NOT NULL,
  operation text NOT NULL,
  start_date date NOT NULL,
  end_date_exclusive date NOT NULL,
  page_token text,
  next_page_token text,
  status text NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_by text,
  claimed_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (sync_job_id, metric, operation, start_date, end_date_exclusive, page_token)
);

CREATE INDEX sync_chunks_claim_idx ON sync_chunks (status, created_at);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  civil_date date NOT NULL,
  occurred_at timestamptz NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz
);

CREATE INDEX journal_entries_date_idx ON journal_entries (source_account_id, civil_date, occurred_at);

CREATE TABLE journal_entry_revisions (
  id uuid PRIMARY KEY,
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  ciphertext text NOT NULL,
  nonce text NOT NULL,
  auth_tag text NOT NULL,
  key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (journal_entry_id, revision_number)
);

CREATE TABLE journal_tags (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  normalized_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, normalized_name)
);

CREATE TABLE journal_entry_tags (
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  journal_tag_id uuid NOT NULL REFERENCES journal_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (journal_entry_id, journal_tag_id)
);

CREATE TABLE export_jobs (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  export_type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  start_date date NOT NULL,
  end_date_exclusive date NOT NULL,
  metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail_level text NOT NULL DEFAULT 'analysis',
  include_journal boolean NOT NULL DEFAULT false,
  include_png boolean NOT NULL DEFAULT false,
  file_path text,
  file_name text,
  size_bytes bigint,
  expires_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX export_jobs_status_idx ON export_jobs (status, created_at);
