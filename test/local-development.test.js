import assert from 'node:assert/strict';
import test from 'node:test';

import { createDevelopmentConfig } from '../scripts/dev-config.mjs';

test('default development mode requires live gateway credentials and uses the live volume', () => {
  const config = createDevelopmentConfig({
    mode: 'live',
    sourceEnv: {
      N8N_WEBHOOK_URL: 'https://n8n.philippeho.dev/webhook/health-hub-sync',
      N8N_WEBHOOK_TOKEN: 'test-token',
    },
  });

  assert.equal(config.seedFixtures, false);
  assert.equal(config.composeProjectName, 'health-hub-live');
  assert.deepEqual(config.conflictingComposeProjectNames, [
    'health-hub-fixtures',
    'personal-health-data-hub',
  ]);
  assert.equal(config.postgresVolume, 'health-hub-postgres-live');
  assert.deepEqual(config.composeUpArgs.slice(-4), [
    'up',
    '-d',
    '--force-recreate',
    'postgres',
  ]);
  assert.equal(config.env.DASHBOARD_PASSWORD, '0000');
  assert.equal(config.env.SYNC_SCHEDULE_ENABLED, 'false');
});

test('fixture mode has no n8n dependency and uses a different volume', () => {
  const config = createDevelopmentConfig({
    mode: 'fixtures',
    sourceEnv: { SYNC_SCHEDULE_ENABLED: 'true' },
  });

  assert.equal(config.seedFixtures, true);
  assert.equal(config.composeProjectName, 'health-hub-fixtures');
  assert.deepEqual(config.conflictingComposeProjectNames, [
    'health-hub-live',
    'personal-health-data-hub',
  ]);
  assert.equal(config.postgresVolume, 'health-hub-postgres-fixtures');
  assert.equal(config.env.N8N_WEBHOOK_URL, undefined);
  assert.equal(config.env.N8N_WEBHOOK_TOKEN, undefined);
  assert.equal(config.env.SYNC_SCHEDULE_ENABLED, 'false');
});

test('live mode rejects missing, placeholder, or legacy gateway configuration', () => {
  assert.throws(
    () => createDevelopmentConfig({ mode: 'live', sourceEnv: {} }),
    /Create .env.local/,
  );
  assert.throws(
    () => createDevelopmentConfig({
      mode: 'live',
      sourceEnv: {
        N8N_WEBHOOK_URL: 'https://n8n.philippeho.dev/webhook/fitness-sync',
        N8N_WEBHOOK_TOKEN: 'replace-me',
      },
    }),
    /health-hub-sync/,
  );
});
