import { GOOGLE_HEALTH_METRICS } from './planner.js';

const OPERATIONS = new Set(['profile', 'identity', 'list', 'reconcile', 'dailyRollup']);
const COMBINATIONS = {
  profile: new Set(['sleep']),
  identity: new Set(['sleep']),
  list: new Set([
    'heart-rate',
    'daily-resting-heart-rate',
    'active-energy-burned',
    'basal-energy-burned',
  ]),
  reconcile: new Set(['sleep']),
  dailyRollup: new Set(['total-calories']),
};
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validate(request) {
  if (
    !OPERATIONS.has(request.operation) ||
    !GOOGLE_HEALTH_METRICS.includes(request.metric) ||
    !COMBINATIONS[request.operation]?.has(request.metric)
  ) {
    throw new Error('Unsupported gateway request');
  }
  if (!['profile', 'identity'].includes(request.operation)) {
    if (
      !DATE_PATTERN.test(String(request.startDate || '')) ||
      !DATE_PATTERN.test(String(request.endDateExclusive || '')) ||
      request.startDate >= request.endDateExclusive
    ) {
      throw new Error('Unsupported gateway request');
    }
  }
}

export function createGoogleHealthGateway({
  url,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 35_000,
}) {
  return {
    async request(request) {
      validate(request);
      if (!url || !token) throw new Error('n8n gateway is not configured');
      const payload = {
        operation: request.operation,
        metric: request.metric,
        startDate: request.startDate ?? null,
        endDateExclusive: request.endDateExclusive ?? null,
        pageToken: request.pageToken ?? null,
      };
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
