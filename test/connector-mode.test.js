import assert from 'node:assert/strict';
import test from 'node:test';
import { selectGoogleHealthGateway } from '../server.js';
import { buildGatewayFromEnv, buildGoogleHealthRuntime } from '../scripts/connector-support.mjs';

test('defaults to the n8n gateway', () => {
  assert.equal(selectGoogleHealthGateway({ env: {}, n8nGateway: { name: 'n8n' }, directClient: { name: 'direct' } }).name, 'n8n');
});
test('selects the direct client when asked', () => {
  assert.equal(selectGoogleHealthGateway({ env: { GOOGLE_CONNECTOR_MODE: 'direct' }, n8nGateway: { name: 'n8n' }, directClient: { name: 'direct' } }).name, 'direct');
});
test('falls back to n8n when direct is requested but unavailable', () => {
  assert.equal(selectGoogleHealthGateway({ env: { GOOGLE_CONNECTOR_MODE: 'direct' }, n8nGateway: { name: 'n8n' }, directClient: null }).name, 'n8n');
});

const env = {
  N8N_WEBHOOK_URL: 'https://n8n.example.com/hook', N8N_WEBHOOK_TOKEN: 'test-token',
  GOOGLE_OAUTH_CLIENT_ID: 'test-id', GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://health.example.com/api/connectors/google/callback',
  CONNECTOR_ENCRYPTION_KEYS: `1:${Buffer.alloc(32, 7).toString('base64')}`, DASHBOARD_SESSION_SECRET: 'test-only-state-secret',
};

test('server and backfill construction use n8n by default without reading credentials', async () => {
  const pool = { query: () => assert.fail('must not read credentials in n8n mode') };
  const seen = [];
  const options = { env, fetchImpl: async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }; } };
  const runtime = buildGoogleHealthRuntime(pool, options);
  assert.ok(runtime.connector, 'settings must support consent before cutover');
  assert.equal(runtime.mode, 'n8n');
  await runtime.gateway.request({ operation: 'profile', metric: 'sleep' });
  await buildGatewayFromEnv(pool, options).request({ operation: 'identity', metric: 'sleep' });
  assert.deepEqual(seen, [env.N8N_WEBHOOK_URL, env.N8N_WEBHOOK_URL]);
});

test('direct mode works without an n8n gateway, and never falls back on disconnection', async () => {
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const runtime = buildGoogleHealthRuntime(pool, { env: { ...env, GOOGLE_CONNECTOR_MODE: 'direct', N8N_WEBHOOK_URL: '', N8N_WEBHOOK_TOKEN: '' }, fetchImpl: () => assert.fail('must not call n8n or Google without credentials') });
  assert.equal(runtime.mode, 'direct');
  await assert.rejects(runtime.gateway.request({ operation: 'profile', metric: 'sleep' }), { disconnected: true });
});

test('missing direct prerequisites fall back explicitly without breaking n8n', () => {
  const logs = [];
  const runtime = buildGoogleHealthRuntime({}, { env: { ...env, GOOGLE_CONNECTOR_MODE: 'direct', GOOGLE_OAUTH_REDIRECT_URI: '' }, logger: { warn: (message) => logs.push(message) } });
  assert.equal(runtime.mode, 'n8n');
  assert.equal(runtime.connector, null);
  assert.equal(logs.length, 1);
  assert.equal(buildGoogleHealthRuntime(null, { env: {} }).gateway, null);
});
