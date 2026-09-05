import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';
import { applyMigrations } from '../lib/db/migrations.js';
import { buildOwnedConnector } from '../lib/connectors/runtime.js';

const env = {
  GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://health.example.com/api/connectors/google/callback',
  CONNECTOR_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 7).toString('base64')}`,
  DASHBOARD_SESSION_SECRET: 'test-only-session-secret',
  CONNECTOR_ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook', CONNECTOR_ALERT_WEBHOOK_TOKEN: 'alert-secret',
  PUBLIC_ORIGIN: 'https://health.example.com',
};

test('the owned runtime connects, persists invalid_grant and sends exactly one alert', async (t) => {
  const memory = newDb({ noAstCoverageCheck: true });
  const pool = new (memory.adapters.createPg().Pool)();
  t.after(() => pool.end());
  await applyMigrations(pool);
  const calls = [];
  const { connector } = buildOwnedConnector({ pool, env, fetchImpl: async (url, options) => {
    calls.push(url);
    if (url === env.CONNECTOR_ALERT_WEBHOOK_URL) return { ok: true };
    if (options.body.get('grant_type') === 'authorization_code') return { ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 1, scope: 'sleep' }) };
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
  } });
  await connector.connectWithCode('code');
  await assert.rejects(connector.accessToken(), { disconnected: true });
  await assert.rejects(connector.accessToken(), { disconnected: true });
  assert.equal((await connector.status()).connected, false);
  assert.equal(calls.filter((url) => url === env.CONNECTOR_ALERT_WEBHOOK_URL).length, 1);
  assert.equal(calls.length, 3);
});

test('optional configuration is inert and invalid keys cannot break legacy sync', () => {
  const pool = { query: () => assert.fail('must not touch database during construction') };
  assert.equal(buildOwnedConnector({ pool, env: {} }).connector, null);
  const logs = [];
  assert.equal(buildOwnedConnector({ pool, env: { ...env, CONNECTOR_ENCRYPTION_KEYS: 'secret-invalid-key' }, logger: { error: (message) => logs.push(message) } }).connector, null);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes('secret-invalid-key'));
});
