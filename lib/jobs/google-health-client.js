import { buildGoogleHealthRequest } from './google-health-request.js';

export function createGoogleHealthClient({
  connector,
  fetchImpl = globalThis.fetch,
  timeoutMs = 35_000,
}) {
  return {
    async request(request) {
      const built = buildGoogleHealthRequest(request);

      let token;
      try {
        token = await connector.accessToken();
      } catch (error) {
        error.transient = error.disconnected ? false : error.transient !== false;
        throw error;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(built.url, {
          method: built.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(built.body ? { 'content-type': 'application/json' } : {}),
          },
          ...(built.body ? { body: JSON.stringify(built.body) } : {}),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || body?.error) {
          const error = new Error(`Google Health returned HTTP ${response.status}`);
          error.status = response.status;
          error.transient = response.status === 429 || response.status >= 500;
          throw error;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw Object.assign(new Error('Google Health returned an invalid response'), { transient: true });
        }
        return {
          ok: true,
          metric: request.metric,
          status: response.status,
          data: body,
          nextPageToken: body.nextPageToken ?? null,
          message: null,
        };
      } catch (error) {
        if (typeof error.transient === 'boolean') throw error;
        throw Object.assign(new Error('Google Health request failed'), { transient: true });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
