const PROVIDER = 'google-health';
const DEFAULT_SKEW_MS = 120_000;

function disconnectedError(message) {
  const error = new Error(message || 'Google Health is not connected');
  error.disconnected = true;
  error.transient = false;
  error.status = 401;
  return error;
}

export function createGoogleConnector({
  repository,
  oauth,
  now = () => Date.now(),
  refreshSkewMs = DEFAULT_SKEW_MS,
  onDisconnect = null,
}) {
  let inFlight = null;

  function usable(row) {
    if (!row || row.status !== 'connected' || !row.accessToken) return false;
    const expiresAt = row.accessTokenExpiresAt
      ? new Date(row.accessTokenExpiresAt).getTime()
      : 0;
    return expiresAt - refreshSkewMs > now();
  }

  async function performRefresh() {
    const result = await repository.withLock(PROVIDER, async (locked, client) => {
      // Double-checked under the row lock: another process may have refreshed
      // or disconnected while this one waited for the lock.
      if (usable(locked)) return locked.accessToken;
      if (!locked || locked.status === 'disconnected' || !locked.refreshToken) {
        throw disconnectedError(locked?.lastError);
      }

      let tokens;
      try {
        tokens = await oauth.refresh(locked.refreshToken);
      } catch (error) {
        if (!error.fatal) throw error;
        await repository.markDisconnected(PROVIDER, error.message, client ?? undefined);
        // Return, don't throw: withLock must COMMIT the disconnection.
        return { disconnected: true, message: error.message };
      }

      await repository.save(
        PROVIDER,
        {
          googleAccountEmail: locked.googleAccountEmail,
          scope: tokens.scope ?? locked.scope,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          accessTokenExpiresAt: new Date(now() + tokens.expiresInSeconds * 1000),
        },
        client ?? undefined,
      );
      return tokens.accessToken;
    });
    if (result?.disconnected) {
      // The notification is outside the transaction and cannot roll it back.
      try {
        if (onDisconnect) await onDisconnect(result.message);
      } catch {
        // Best-effort notification; the persisted state remains authoritative.
      }
      throw disconnectedError(result.message);
    }
    return result;
  }

  return {
    async accessToken() {
      const row = await repository.load(PROVIDER);
      if (usable(row)) return row.accessToken;
      if (row && row.status === 'disconnected') throw disconnectedError(row.lastError);
      if (inFlight) return inFlight;
      inFlight = performRefresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    async status() {
      const row = await repository.load(PROVIDER);
      return {
        connected: Boolean(row && row.status === 'connected'),
        email: row?.googleAccountEmail ?? null,
        scope: row?.scope ?? null,
        accessTokenExpiresAt: row?.accessTokenExpiresAt ?? null,
        connectedAt: row?.connectedAt ?? null,
        disconnectedAt: row?.disconnectedAt ?? null,
        lastError: row?.lastError ?? null,
      };
    },

    async connectWithCode(code) {
      const tokens = await oauth.exchangeCode(code);
      if (!tokens.refreshToken) {
        throw new Error('Google did not return a refresh token; re-consent is required');
      }
      await repository.save(PROVIDER, {
        googleAccountEmail: null,
        scope: tokens.scope,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: new Date(now() + tokens.expiresInSeconds * 1000),
      });
    },

    disconnect: () => repository.markDisconnected(PROVIDER, 'Disconnected by the owner'),
  };
}
