import crypto from 'node:crypto';

const LOCAL_DATABASE_URL = 'postgres://health_hub:health_hub_dev@127.0.0.1:54329/health_hub';
const LIVE_WEBHOOK_URL = 'https://n8n.philippeho.dev/webhook/health-hub-sync';

function isPlaceholder(value) {
  return !value || /^(replace|change|your|example|placeholder|<)/i.test(value.trim());
}

function validateLiveGateway(env) {
  let webhookUrl;
  try {
    webhookUrl = new URL(env.N8N_WEBHOOK_URL);
  } catch {
    throw new Error('Create .env.local with the health-hub-sync gateway URL and token');
  }

  if (webhookUrl.href !== LIVE_WEBHOOK_URL || isPlaceholder(env.N8N_WEBHOOK_TOKEN)) {
    throw new Error('Create .env.local with the health-hub-sync gateway URL and a non-placeholder token');
  }
}

export function createDevelopmentConfig({ mode = 'live', sourceEnv = {} } = {}) {
  if (!['live', 'fixtures'].includes(mode)) {
    throw new Error('Development mode must be live or fixtures');
  }

  const env = {
    ...sourceEnv,
    NODE_ENV: 'development',
    PORT: '3000',
    DATABASE_URL: LOCAL_DATABASE_URL,
    DASHBOARD_PASSWORD: '0000',
    DASHBOARD_SESSION_SECRET: sourceEnv.DASHBOARD_SESSION_SECRET
      || 'local-session-secret-change-before-production',
    JOURNAL_ENCRYPTION_KEYS: sourceEnv.JOURNAL_ENCRYPTION_KEYS
      || `1:${crypto.createHash('sha256').update('health-hub-local-journal-key').digest('base64')}`,
  };

  if (mode === 'fixtures') {
    delete env.N8N_WEBHOOK_URL;
    delete env.N8N_WEBHOOK_TOKEN;
  } else {
    validateLiveGateway(env);
    env.SYNC_SCHEDULE_ENABLED = 'false';
  }

  const seedFixtures = mode === 'fixtures';
  const composeProjectName = `health-hub-${mode}`;
  const postgresVolume = `health-hub-postgres-${mode}`;
  env.HEALTH_HUB_POSTGRES_VOLUME = postgresVolume;

  return { mode, env, seedFixtures, composeProjectName, postgresVolume };
}
