import crypto from 'node:crypto';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
];

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signState(secret, { nonce = crypto.randomUUID(), issuedAt = Date.now() } = {}) {
  const payload = `${nonce}.${issuedAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyState(secret, state, { now = Date.now(), maxAgeMs = 600_000 } = {}) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, signature] = parts;
  const expected = sign(secret, `${nonce}.${issuedAt}`);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
  const issued = Number(issuedAt);
  return Number.isFinite(issued) && now - issued <= maxAgeMs && now >= issued;
}

function tokenError(body, status) {
  const known = new Set(['invalid_grant', 'invalid_client', 'invalid_request', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'temporarily_unavailable', 'server_error', 'backend_error']);
  const code = known.has(body?.error) ? body.error : `HTTP ${status}`;
  const error = new Error(`Google OAuth: ${code}`);
  error.fatal = code === 'invalid_grant';
  error.transient = !error.fatal;
  error.status = status;
  return error;
}

export function createGoogleOAuthClient({
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
}) {
  async function token(parameters) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.error) throw tokenError(body, response.status);
      if (!body || typeof body.access_token !== 'string' || !body.access_token ||
          !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0) {
        throw Object.assign(new Error('Google OAuth returned an invalid token response'), { fatal: false, transient: true });
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? null,
        expiresInSeconds: Number(body.expires_in),
        scope: body.scope ?? null,
        idToken: body.id_token ?? null,
      };
    } catch (error) {
      if (typeof error.fatal === 'boolean') throw error;
      throw Object.assign(new Error('Google OAuth token request failed'), { fatal: false, transient: true });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    authorizationUrl({ state }) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        scope: GOOGLE_HEALTH_SCOPES.join(' '),
        state,
      }).toString();
      return url.toString();
    },

    exchangeCode: (code) =>
      token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),

    refresh: (refreshToken) =>
      token({ refresh_token: refreshToken, grant_type: 'refresh_token' }),
  };
}
