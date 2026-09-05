import { createKeyringCipher } from '../crypto/keyring.js';
import { createConnectorRepository } from './repository.js';
import { createGoogleOAuthClient } from './google-oauth.js';
import { createGoogleConnector } from './google-connector.js';
import { createConnectorAlerter } from './alerts.js';

// Construct the settings connection independently of which sync path is active.
export function buildOwnedConnector({ pool, env = process.env, fetchImpl = globalThis.fetch, logger = console }) {
  const unavailable = { connector: null, oauth: null };
  if (!pool || !env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET ||
      !env.GOOGLE_OAUTH_REDIRECT_URI || !env.CONNECTOR_ENCRYPTION_KEYS || !env.DASHBOARD_SESSION_SECRET) return unavailable;
  try {
    const cipher = createKeyringCipher({ serializedKeyring: env.CONNECTOR_ENCRYPTION_KEYS, label: 'connector', subject: 'Connector', variableName: 'CONNECTOR_ENCRYPTION_KEYS' });
    const oauth = createGoogleOAuthClient({ clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI, fetchImpl });
    const alerter = createConnectorAlerter({ url: env.CONNECTOR_ALERT_WEBHOOK_URL, token: env.CONNECTOR_ALERT_WEBHOOK_TOKEN, publicOrigin: env.PUBLIC_ORIGIN, fetchImpl, logger });
    const connector = createGoogleConnector({ repository: createConnectorRepository(pool, cipher), oauth, onDisconnect: (message) => alerter.notifyDisconnected(message) });
    return { connector, oauth };
  } catch {
    logger.error('Google connector is disabled because its configuration is invalid');
    return unavailable;
  }
}
