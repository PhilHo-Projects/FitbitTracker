CREATE TABLE operational_snapshots (
  civil_date date PRIMARY KEY,
  captured_at timestamptz NOT NULL,
  database_bytes bigint NOT NULL CHECK (database_bytes >= 0),
  heart_rate_samples_bytes bigint NOT NULL CHECK (heart_rate_samples_bytes >= 0),
  oxygen_saturation_samples_bytes bigint NOT NULL CHECK (oxygen_saturation_samples_bytes >= 0),
  filesystem_total_bytes bigint NOT NULL CHECK (filesystem_total_bytes > 0),
  filesystem_available_bytes bigint NOT NULL CHECK (filesystem_available_bytes >= 0),
  filesystem_used_percent numeric(5,2) NOT NULL CHECK (
    filesystem_used_percent >= 0 AND filesystem_used_percent <= 100
  )
);

