CREATE TABLE oxygen_saturation_samples (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text NOT NULL,
  source_key text NOT NULL,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL,
  sample_time_text text NOT NULL,
  utc_offset_seconds numeric NOT NULL CHECK (utc_offset_seconds > -86400 AND utc_offset_seconds < 86400),
  percentage numeric NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, provider_key)
);
CREATE INDEX oxygen_samples_time_idx ON oxygen_saturation_samples (source_account_id, sampled_at);
CREATE INDEX oxygen_samples_date_idx ON oxygen_saturation_samples (source_account_id, civil_date, sampled_at);

CREATE TABLE oxygen_saturation_daily_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text NOT NULL,
  source_key text NOT NULL,
  civil_date date NOT NULL,
  average_percentage numeric NOT NULL CHECK (average_percentage >= 0 AND average_percentage <= 100),
  lower_bound_percentage numeric CHECK (lower_bound_percentage >= 0 AND lower_bound_percentage <= 100),
  upper_bound_percentage numeric CHECK (upper_bound_percentage >= 0 AND upper_bound_percentage <= 100),
  standard_deviation_percentage numeric CHECK (standard_deviation_percentage >= 0),
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (lower_bound_percentage IS NULL OR upper_bound_percentage IS NULL OR lower_bound_percentage <= upper_bound_percentage),
  UNIQUE (source_account_id, provider_key)
);
CREATE INDEX oxygen_daily_date_idx ON oxygen_saturation_daily_summaries (source_account_id, civil_date, source_key);
