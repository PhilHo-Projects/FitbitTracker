import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createConnectorRouter } from '../lib/routes/connector-routes.js';
import { signState } from '../lib/connectors/google-oauth.js';

const SECRET = 'test-secret-value';

function createServer({ connector, oauth }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/connectors',
    createConnectorRouter({
      connector,
      oauth,
      secret: SECRET,
      requireAuth: (_req, _res, next) => next(),
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
  );
  assert.match(response.headers.get('location'), /error=access_denied/);
  server.close();
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
