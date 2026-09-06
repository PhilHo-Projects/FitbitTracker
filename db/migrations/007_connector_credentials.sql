-- Third-party API connections owned by this application.
-- Distinct from Better Auth's "account" table, which describes login identities.

CREATE TABLE connector_credentials (
  id uuid PRIMARY KEY,
  provider text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'disconnected',
  google_account_email text,
  scope text,
  access_token_ciphertext text,
  access_token_nonce text,
  access_token_auth_tag text,
  access_token_key_version integer,
  refresh_token_ciphertext text,
  refresh_token_nonce text,
  refresh_token_auth_tag text,
  refresh_token_key_version integer,
  access_token_expires_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_refresh_at timestamptz,
  last_error text,
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
