import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionToken, readCookie, verifySessionToken } from '../lib/session.js';

const secret = 'test-session-secret-that-is-long-enough';
const now = Date.parse('2026-07-16T12:00:00Z');

test('creates a session token that verifies before expiry', () => {
  const token = createSessionToken(secret, now, 60_000);

  assert.equal(verifySessionToken(token, secret, now + 59_999), true);
});

test('rejects a session token after expiry', () => {
  const token = createSessionToken(secret, now, 60_000);

  assert.equal(verifySessionToken(token, secret, now + 60_001), false);
});

test('rejects a tampered session token', () => {
  const token = createSessionToken(secret, now, 60_000);
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

  assert.equal(verifySessionToken(tampered, secret, now + 1_000), false);
});

test('reads a named cookie from a cookie header', () => {
  assert.equal(readCookie('theme=dark; fitbit_session=abc.def; other=1', 'fitbit_session'), 'abc.def');
  assert.equal(readCookie('', 'fitbit_session'), null);
});

