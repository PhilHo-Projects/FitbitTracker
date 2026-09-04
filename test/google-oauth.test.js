import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleOAuthClient,
  GOOGLE_HEALTH_SCOPES,
  signState,
  verifyState,
} from '../lib/connectors/google-oauth.js';

function client(fetchImpl) {
  return createGoogleOAuthClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/connectors/google/callback',
    fetchImpl,
  });
}

test('requests exactly the four health scopes', () => {
  assert.equal(GOOGLE_HEALTH_SCOPES.length, 4);
  assert.ok(
    GOOGLE_HEALTH_SCOPES.includes(
      'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    ),
  );
  for (const unwanted of ['location', 'nutrition', 'ecg', 'irn']) {
    assert.ok(!GOOGLE_HEALTH_SCOPES.some((scope) => scope.includes(unwanted)));
  }
});

test('the authorization url forces a refresh token to be issued', () => {
  const url = new URL(client().authorizationUrl({ state: 'abc' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'abc');
  assert.equal(url.searchParams.get('scope'), GOOGLE_HEALTH_SCOPES.join(' '));
});

test('signed state round trips and rejects tampering', () => {
  const state = signState('secret', { nonce: 'n1', issuedAt: 1000 });
  assert.equal(verifyState('secret', state, { now: 2000, maxAgeMs: 600_000 }), true);
  assert.equal(verifyState('other-secret', state, { now: 2000, maxAgeMs: 600_000 }), false);
  assert.equal(verifyState('secret', `${state}x`, { now: 2000, maxAgeMs: 600_000 }), false);
});

test('signed state expires', () => {
  const state = signState('secret', { nonce: 'n1', issuedAt: 1000 });
  assert.equal(verifyState('secret', state, { now: 999_999, maxAgeMs: 600_000 }), false);
});

test('exchangeCode returns normalized tokens', async () => {
  const subject = client(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'a1',
      refresh_token: 'r1',
      expires_in: 3599,
      scope: 'one two',
      id_token: 'id1',
    }),
  }));
  const result = await subject.exchangeCode('code-value');
  assert.deepEqual(result, {
    accessToken: 'a1',
    refreshToken: 'r1',
    expiresInSeconds: 3599,
    scope: 'one two',
    idToken: 'id1',
  });
});

test('invalid_grant is fatal', async () => {
  const subject = client(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Bad Request' }),
  }));
  await assert.rejects(subject.refresh('r1'), (error) => {
    assert.equal(error.fatal, true);
    assert.match(error.message, /invalid_grant/);
    return true;
  });
});

test('a server error is not fatal', async () => {
  const subject = client(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'backend_error' }),
  }));
  await assert.rejects(subject.refresh('r1'), (error) => {
    assert.equal(error.fatal, false);
    return true;
  });
});

test('a transport error is not fatal', async () => {
  const subject = client(async () => {
    throw new Error('network down');
  });
  await assert.rejects(subject.refresh('r1'), (error) => {
    assert.equal(error.fatal, false);
    return true;
  });
});

test('refresh tolerates Google omitting a new refresh token', async () => {
  const subject = client(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'a2', expires_in: 3599, scope: 'one' }),
  }));
  const result = await subject.refresh('r1');
  assert.equal(result.accessToken, 'a2');
  assert.equal(result.refreshToken, null);
});
