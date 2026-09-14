import crypto from 'node:crypto';

function sealed(cipher, value) {
  if (value === null || value === undefined) {
    return { ciphertext: null, nonce: null, authTag: null, keyVersion: null };
  }
  const result = cipher.encrypt(value);
  return {
    ciphertext: result.ciphertext.toString('base64'),
    nonce: result.nonce.toString('base64'),
    authTag: result.authTag.toString('base64'),
    keyVersion: result.keyVersion,
  };
}

function opened(cipher, ciphertext, nonce, authTag, keyVersion) {
  if (!ciphertext || !nonce || !authTag) return null;
  return cipher.decrypt({ ciphertext, nonce, authTag, keyVersion });
}

function present(cipher, row) {
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    googleAccountEmail: row.google_account_email,
    scope: row.scope,
    accessToken: opened(
      cipher,
      row.access_token_ciphertext,
      row.access_token_nonce,
      row.access_token_auth_tag,
      row.access_token_key_version,
    ),
    refreshToken: opened(
      cipher,
      row.refresh_token_ciphertext,
      row.refresh_token_nonce,
      row.refresh_token_auth_tag,
      row.refresh_token_key_version,
    ),
    accessTokenExpiresAt: row.access_token_expires_at,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    lastRefreshAt: row.last_refresh_at,
    lastError: row.last_error,
    alertedAt: row.alerted_at,
    connectionGeneration: row.connection_generation,
    recoveryFrom: row.recovery_from,
    recoveryPending: row.recovery_pending,
  };
}

export function createConnectorRepository(pool, cipher) {
  async function loadWith(runner, provider) {
    const rows = await runner.query(
      'SELECT * FROM connector_credentials WHERE provider = $1',
      [provider],
    );
    return present(cipher, rows.rows[0]);
  }

  return {
    load: (provider) => loadWith(pool, provider),

    async save(provider, {
      googleAccountEmail,
      scope,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
      connectionGeneration = null,
      recoveryFrom = null,
    }, runner = pool) {
      const access = sealed(cipher, accessToken);
      const refresh = sealed(cipher, refreshToken);
      await runner.query(
        `INSERT INTO connector_credentials (
           id, provider, status, google_account_email, scope,
           access_token_ciphertext, access_token_nonce, access_token_auth_tag,
           access_token_key_version,
           refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
           refresh_token_key_version, access_token_expires_at, connected_at,
           disconnected_at, last_refresh_at, last_error, alerted_at,
           connection_generation, recovery_from, recovery_pending
         ) VALUES (
           $1, $2, 'connected', $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12, $13, CURRENT_TIMESTAMP,
           NULL, CURRENT_TIMESTAMP, NULL, NULL, $14, $15, $16
         )
         ON CONFLICT (provider) DO UPDATE SET
           status = 'connected',
           google_account_email = COALESCE(
             EXCLUDED.google_account_email,
             connector_credentials.google_account_email
           ),
           scope = COALESCE(EXCLUDED.scope, connector_credentials.scope),
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           access_token_nonce = EXCLUDED.access_token_nonce,
           access_token_auth_tag = EXCLUDED.access_token_auth_tag,
           access_token_key_version = EXCLUDED.access_token_key_version,
           refresh_token_ciphertext = COALESCE(
             EXCLUDED.refresh_token_ciphertext,
             connector_credentials.refresh_token_ciphertext
           ),
           refresh_token_nonce = COALESCE(
             EXCLUDED.refresh_token_nonce,
             connector_credentials.refresh_token_nonce
           ),
           refresh_token_auth_tag = COALESCE(
             EXCLUDED.refresh_token_auth_tag,
             connector_credentials.refresh_token_auth_tag
           ),
           refresh_token_key_version = COALESCE(
             EXCLUDED.refresh_token_key_version,
             connector_credentials.refresh_token_key_version
           ),
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           connected_at = CASE WHEN $16 THEN EXCLUDED.connected_at ELSE COALESCE(connector_credentials.connected_at, EXCLUDED.connected_at) END,
           connection_generation = COALESCE(EXCLUDED.connection_generation, connector_credentials.connection_generation),
           recovery_from = CASE WHEN $16 THEN EXCLUDED.recovery_from ELSE connector_credentials.recovery_from END,
           recovery_pending = CASE WHEN $16 THEN true ELSE connector_credentials.recovery_pending END,
           disconnected_at = NULL,
           last_refresh_at = CURRENT_TIMESTAMP,
           last_error = NULL,
           alerted_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
        [
          crypto.randomUUID(),
          provider,
          googleAccountEmail ?? null,
          scope ?? null,
          access.ciphertext,
          access.nonce,
          access.authTag,
          access.keyVersion,
          refresh.ciphertext,
          refresh.nonce,
          refresh.authTag,
          refresh.keyVersion,
          accessTokenExpiresAt ?? null,
          connectionGeneration,
          recoveryFrom,
          Boolean(connectionGeneration),
        ],
      );
    },

    async recoveryScheduled(provider, generation) {
      await pool.query('UPDATE connector_credentials SET recovery_pending = false WHERE provider = $1 AND connection_generation = $2', [provider, generation]);
    },

    async markDisconnected(provider, message, runner = pool) {
      await runner.query(
        `UPDATE connector_credentials
         SET status = 'disconnected',
             last_error = $2,
             disconnected_at = COALESCE(disconnected_at, CURRENT_TIMESTAMP),
             updated_at = CURRENT_TIMESTAMP
         WHERE provider = $1`,
        [provider, message ?? null],
      );
    },

    async markAlerted(provider, at, runner = pool) {
      await runner.query(
        'UPDATE connector_credentials SET alerted_at = $2, updated_at = CURRENT_TIMESTAMP WHERE provider = $1',
        [provider, at ?? new Date()],
      );
    },

    async withLock(provider, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rows = await client.query(
          'SELECT * FROM connector_credentials WHERE provider = $1 FOR UPDATE',
          [provider],
        );
        const result = await fn(present(cipher, rows.rows[0]), client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
