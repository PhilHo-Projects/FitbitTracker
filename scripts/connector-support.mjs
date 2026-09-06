import { buildOwnedConnector } from '../lib/connectors/runtime.js';
import { createGoogleHealthClient } from '../lib/jobs/google-health-client.js';
import { createGoogleHealthGateway } from '../lib/jobs/google-health-gateway.js';

export function selectGoogleHealthGateway({ env = process.env, n8nGateway, directClient }) {
  if (env.GOOGLE_CONNECTOR_MODE === 'direct' && directClient) return directClient;
  return n8nGateway;
}

export function buildGoogleHealthRuntime(pool, { env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const { connector, oauth } = buildOwnedConnector({ pool, env, fetchImpl, logger });
  const n8nGateway = env.N8N_WEBHOOK_URL && env.N8N_WEBHOOK_TOKEN
    ? createGoogleHealthGateway({ url: env.N8N_WEBHOOK_URL, token: env.N8N_WEBHOOK_TOKEN, fetchImpl }) : null;
  const directClient = connector ? createGoogleHealthClient({ connector, fetchImpl }) : null;
  if (env.GOOGLE_CONNECTOR_MODE === 'direct' && !directClient) {
    logger.warn('Direct Google connector is unavailable; using the configured n8n gateway if present');
  }
  const gateway = selectGoogleHealthGateway({ env, n8nGateway, directClient });
  return { gateway, connector, oauth, mode: directClient && gateway === directClient ? 'direct' : 'n8n' };
}

export function buildGatewayFromEnv(pool, options) {
  return buildGoogleHealthRuntime(pool, options).gateway;
}
