CREATE TABLE sleep_hrv_daily (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  source_key text NOT NULL,
  civil_date date NOT NULL,

  rmssd_ms numeric,
  non_rem_bpm numeric,
  entropy numeric,
  deep_rmssd_ms numeric,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_account_id,provider_key)
);
CREATE INDEX sleep_hrv_daily_date_idx ON sleep_hrv_daily(source_account_id,civil_date,source_key);


CREATE TABLE sleep_hrv_samples (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  source_key text NOT NULL,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL, sample_time_text text NOT NULL, utc_offset_seconds integer,

  rmssd_ms numeric,
  sdnn_ms numeric,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_account_id,provider_key)
);
CREATE INDEX sleep_hrv_samples_date_idx ON sleep_hrv_samples(source_account_id,civil_date,source_key);
CREATE INDEX sleep_hrv_samples_time_idx ON sleep_hrv_samples(source_account_id,sampled_at);

CREATE TABLE sleep_respiratory_daily (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  source_key text NOT NULL,
  civil_date date NOT NULL,

  breaths_per_minute numeric,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_account_id,provider_key)
);
CREATE INDEX sleep_respiratory_daily_date_idx ON sleep_respiratory_daily(source_account_id,civil_date,source_key);


CREATE TABLE sleep_respiratory_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  source_key text NOT NULL,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL, sample_time_text text NOT NULL, utc_offset_seconds integer,

  breaths_per_minute numeric,
  standard_deviation numeric,
  signal_to_noise numeric,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_account_id,provider_key)
);
CREATE INDEX sleep_respiratory_summaries_date_idx ON sleep_respiratory_summaries(source_account_id,civil_date,source_key);
CREATE INDEX sleep_respiratory_summaries_time_idx ON sleep_respiratory_summaries(source_account_id,sampled_at);

CREATE TABLE sleep_temperature_daily (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  source_key text NOT NULL,
  civil_date date NOT NULL,

  temperature_celsius numeric,
  baseline_celsius numeric,
  relative_stddev_celsius numeric,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_account_id,provider_key)
);
CREATE INDEX sleep_temperature_daily_date_idx ON sleep_temperature_daily(source_account_id,civil_date,source_key);

CREATE TABLE sleep_preferences (
  source_account_id uuid PRIMARY KEY REFERENCES source_accounts(id) ON DELETE CASCADE,
  goal_minutes integer NOT NULL DEFAULT 420 CHECK(goal_minutes >= 60 AND goal_minutes <= 1440),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sleep_check_ins (
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  civil_date date NOT NULL,
  ciphertext text NOT NULL, nonce text NOT NULL, auth_tag text NOT NULL, key_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_account_id,civil_date)
);
ALTER TABLE export_jobs ADD COLUMN include_sleep_check_ins boolean NOT NULL DEFAULT false;
