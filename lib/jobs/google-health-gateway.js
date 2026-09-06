import { validateGoogleHealthRequest } from './google-health-request.js';

export function createGoogleHealthGateway({
  url,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 35_000,
}) {
  return {
    async request(request) {
      validateGoogleHealthRequest(request);
      if (!url || !token) throw new Error('n8n gateway is not configured');
      const payload = {
        operation: request.operation,
        metric: request.metric,
        startDate: request.startDate ?? null,
        endDateExclusive: request.endDateExclusive ?? null,
        pageToken: request.pageToken ?? null,
      };
      if (request.timezone != null) payload.timezone = request.timezone;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-fitness-token': token,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) {
          const status = Number(body.status || response.status);
          const error = new Error(
            body.message || body.error || `n8n gateway returned HTTP ${response.status}`,
          );
          error.status = status;
          error.transient = status === 429 || status >= 500;
          throw error;
        }
        return body;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
