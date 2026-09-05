import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectorAlerter } from '../lib/connectors/alerts.js';

const config = { url: 'https://n8n.example.com/webhook/alert', token: 'shared-token', publicOrigin: 'https://fitbit.example.com/' };

test('posts a reconnect link with the shared token', async () => {
  let seen;
  const alerter = createConnectorAlerter({ ...config, fetchImpl: async (url, options) => {
    seen = { url, options }; return { ok: true, status: 200 };
  } });
  await alerter.notifyDisconnected('invalid_grant: Bad Request');
  assert.equal(seen.url, config.url);
  assert.equal(seen.options.headers['x-fitness-token'], config.token);
  const body = JSON.parse(seen.options.body);
  assert.match(body.text, /invalid_grant/);
  assert.equal(body.reconnectUrl, 'https://fitbit.example.com/settings');
  assert.equal(body.source, 'health-hub-connector');
  assert.equal(body.severity, 'warning');
  assert.ok(Number.isFinite(Date.parse(body.occurredAt)));
});

test('network and non-2xx failures are logged safely and never throw', async () => {
  for (const fetchImpl of [async () => { throw new Error('secret-token'); }, async () => ({ ok: false, status: 503 })]) {
    const logged = [];
    const alerter = createConnectorAlerter({ ...config, fetchImpl, logger: { error: (...args) => logged.push(args) } });
    await alerter.notifyDisconnected('invalid_grant');
    assert.equal(logged.length, 1);
    assert.ok(!JSON.stringify(logged).includes('secret-token'));
  }
});

test('an unconfigured alerter is a no-op', async () => {
  await createConnectorAlerter({ url: '', token: '', publicOrigin: '', fetchImpl: () => assert.fail('unexpected fetch') }).notifyDisconnected('invalid_grant');
});

test('a stalled webhook is bounded and cannot hold up disconnection forever', async () => {
  const logged = [];
  await createConnectorAlerter({ ...config, timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')))),
    logger: { error: (message) => logged.push(message) },
  }).notifyDisconnected('invalid_grant');
  assert.equal(logged.length, 1);
});

test('notification payloads do not include arbitrary upstream error text', async () => {
  await createConnectorAlerter({ ...config, fetchImpl: async (_url, { body }) => {
    assert.ok(!body.includes('secret-token')); return { ok: true };
  } }).notifyDisconnected('invalid_grant: secret-token');
});
