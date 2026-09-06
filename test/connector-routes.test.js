import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createConnectorRouter } from '../lib/routes/connector-routes.js';
import { signState } from '../lib/connectors/google-oauth.js';

const SECRET = 'test-secret-value';

function createServer({ connector, oauth, healthStatus, requireAuth = (_req, _res, next) => next() }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/connectors',
    createConnectorRouter({
      connector,
      oauth,
      healthStatus,
      secret: SECRET,
      requireAuth,
    }),
  );
  return app.listen(0);
}

async function call(server, path, options) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...options });
}

test('status never leaks a token', async () => {
  const server = createServer({
    connector: {
      async status() {
        return { connected: true, email: 'owner@example.com', scope: 'a', lastError: null };
      },
    },
    oauth: {},
  });
  const response = await call(server, '/api/connectors/google');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.connected, true);
  assert.ok(!JSON.stringify(body).toLowerCase().includes('token'));
  server.close();
});

test('status includes stored-data health even before OAuth is configured', async (t) => {
  const server = createServer({ healthStatus: async () => ({ newestMeasurementAt: '2026-07-24T18:00:00Z', lastSuccessfulSync: '2026-07-24T19:00:00Z' }) });
  t.after(() => server.close());
  const response = await call(server, '/api/connectors/google');
  const { data } = await response.json();
  assert.equal(data.configured, false);
  assert.equal(data.lastSuccessfulSync, '2026-07-24T19:00:00Z');
  assert.equal(data.newestMeasurementAt, '2026-07-24T18:00:00Z');
  assert.equal((await call(server, '/api/connectors/google/authorize', { method: 'POST' })).status, 503);
});

test('authorize returns a signed-state url', async () => {
  const server = createServer({
    connector: {},
    oauth: { authorizationUrl: ({ state }) => `https://accounts.google.com/x?state=${state}` },
  });
  const response = await call(server, '/api/connectors/google/authorize', { method: 'POST' });
  const body = await response.json();
  assert.match(body.data.url, /^https:\/\/accounts\.google\.com\/x\?state=/);
  server.close();
});

test('the callback rejects a forged state without exchanging anything', async () => {
  let exchanges = 0;
  const server = createServer({
    connector: { async connectWithCode() { exchanges += 1; } },
    oauth: {},
  });
  const response = await call(server, '/api/connectors/google/callback?code=c&state=forged');
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /error=invalid_state/);
  assert.equal(exchanges, 0);
  server.close();
});

test('the callback stores tokens for a valid state', async () => {
  let code = null;
  const server = createServer({
    connector: { async connectWithCode(value) { code = value; } },
    oauth: {},
  });
  const state = signState(SECRET, {});
  const response = await call(
    server,
    `/api/connectors/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `google_health_oauth_state=${state}` } },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/settings?connected=1');
  assert.equal(code, 'auth-code');
  server.close();
});

test('the callback surfaces a denied consent', async () => {
  const server = createServer({ connector: {}, oauth: {} });
  const state = signState(SECRET, {});
  const response = await call(
    server,
    `/api/connectors/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `google_health_oauth_state=${state}` } },
  );
  assert.match(response.headers.get('location'), /error=access_denied/);
  server.close();
});

test('a signed state cannot be used from another browser', async (t) => {
  const server = createServer({ connector: { connectWithCode: () => assert.fail('must not exchange') }, oauth: {} });
  t.after(() => server.close());
  const state = signState(SECRET);
  for (const cookie of ['', `google_health_oauth_state=${signState(SECRET)}`]) {
    const response = await call(server, `/api/connectors/google/callback?code=c&state=${state}`, { headers: { cookie } });
    assert.equal(response.headers.get('location'), '/settings?error=invalid_state');
  }
});

test('authorization sets a callback-scoped HttpOnly Lax cookie and callback clears it', async (t) => {
  let exchanged = null;
  const server = createServer({
    connector: { connectWithCode: (code) => { exchanged = code; } },
    oauth: { authorizationUrl: ({ state }) => `https://accounts.google.com/x?state=${state}` },
  });
  t.after(() => server.close());
  const start = await call(server, '/api/connectors/google/authorize', { method: 'POST' });
  const cookie = start.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/connectors\/google\/callback/);
  const state = new URL((await start.json()).data.url).searchParams.get('state');
  const response = await call(server, `/api/connectors/google/callback?code=c&state=${state}`, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(exchanged, 'c');
  assert.equal(response.headers.get('location'), '/settings?connected=1');
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
});

test('callback failures never reflect upstream secrets into the redirect', async (t) => {
  const server = createServer({ connector: { connectWithCode: () => { throw new Error('secret-token'); } }, oauth: {} });
  t.after(() => server.close());
  const state = signState(SECRET);
  for (const query of ['code=c', 'error=secret-token']) {
    const response = await call(server, `/api/connectors/google/callback?${query}&state=${state}`, { headers: { cookie: `google_health_oauth_state=${state}` } });
    assert.equal(response.headers.get('location'), '/settings?error=connection_failed');
  }
});

test('all connector endpoints require owner authentication', async (t) => {
  const server = createServer({ connector: {}, oauth: {}, requireAuth: (_req, res) => res.sendStatus(401) });
  t.after(() => server.close());
  for (const [path, method] of [['', 'GET'], ['/authorize', 'POST'], ['/callback', 'GET'], ['/disconnect', 'POST']]) {
    assert.equal((await call(server, `/api/connectors/google${path}`, { method })).status, 401);
  }
});

test('disconnect delegates to the connector', async () => {
  let called = false;
  const server = createServer({
    connector: { async disconnect() { called = true; } },
    oauth: {},
  });
  const response = await call(server, '/api/connectors/google/disconnect', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(called, true);
  server.close();
});
