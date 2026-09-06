import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createApp } from '../server.js';
import { createTestAuth, OWNER_PASSWORD, signIn, signInCookie } from '../test-support/auth.js';

const env = {
  NODE_ENV: 'test',
  DASHBOARD_PASSWORD: 'correct horse battery staple',
  DASHBOARD_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
  N8N_WEBHOOK_URL: 'https://n8n.example.test/webhook/fitness-sync',
  N8N_WEBHOOK_TOKEN: 'webhook-secret',
};

async function withServer(fetchImpl, run) {
  const { auth } = await createTestAuth(env);
  const server = http.createServer(createApp({ env, fetchImpl, auth }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('redirects an unauthenticated dashboard request to login', async () => {
  await withServer(globalThis.fetch, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    const directIndex = await fetch(`${baseUrl}/index.html`, { redirect: 'manual' });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(directIndex.status, 302);
    assert.equal(directIndex.headers.get('location'), '/login');
  });
});

test('rejects an invalid password', async () => {
  await withServer(globalThis.fetch, async (baseUrl) => {
    const response = await signIn(baseUrl, { password: 'wrong-password-entirely' });

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

test('refuses to create additional accounts', async () => {
  await withServer(globalThis.fetch, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ email: 'intruder@example.test', password: OWNER_PASSWORD, name: 'Intruder' }),
    });

    assert.equal(response.ok, false);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

test('sets a secure session cookie after a valid login', async () => {
  await withServer(globalThis.fetch, async (baseUrl) => {
    const response = await signIn(baseUrl);
    const cookie = response.headers.get('set-cookie');

    assert.equal(response.status, 200);
    assert.match(cookie, /^fitbit_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });
});

test('protects the sleep API and forwards authenticated requests to n8n', async () => {
  const upstreamCalls = [];
  const fetchImpl = async (url, options) => {
    upstreamCalls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, latest: { date: '2026-07-16' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await withServer(fetchImpl, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/sleep`, { method: 'POST' });
    assert.equal(denied.status, 401);

    const cookie = await signInCookie(baseUrl);

    const response = await fetch(`${baseUrl}/api/sleep`, {
      method: 'POST',
      headers: { cookie },
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, env.N8N_WEBHOOK_URL);
    assert.equal(upstreamCalls[0].options.headers['x-fitness-token'], env.N8N_WEBHOOK_TOKEN);
  });
});
