import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { createAuth } from '../lib/auth.js';

function pool() {
  return new (newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool)();
}

const secret = 'test-session-secret-that-is-long-enough';

test('authentication stays unconfigured without a pool or a secret', () => {
  assert.equal(createAuth({ pool: pool(), env: {} }), null);
  assert.equal(createAuth({ pool: null, env: { DASHBOARD_SESSION_SECRET: secret } }), null);
});

test('every configured public origin is trusted and the first is canonical', () => {
  const auth = createAuth({
    pool: pool(),
    env: {
      DASHBOARD_SESSION_SECRET: secret,
      PUBLIC_ORIGIN: 'https://fitbit.example.dev, https://fitbit-staging.example.dev',
    },
  });

  assert.equal(auth.options.baseURL, 'https://fitbit.example.dev');
  assert.deepEqual(auth.options.trustedOrigins, [
    'https://fitbit.example.dev',
    'https://fitbit-staging.example.dev',
  ]);
});

test('an unset public origin trusts nothing explicitly', () => {
  const auth = createAuth({ pool: pool(), env: { DASHBOARD_SESSION_SECRET: secret } });

  assert.equal(auth.options.baseURL, undefined);
  assert.deepEqual(auth.options.trustedOrigins, []);
});

test('sign-up is disabled unless the seeding script asks for it', () => {
  const env = { DASHBOARD_SESSION_SECRET: secret };

  assert.equal(createAuth({ pool: pool(), env }).options.emailAndPassword.disableSignUp, true);
  assert.equal(
    createAuth({ pool: pool(), env, allowSignUp: true }).options.emailAndPassword.disableSignUp,
    false,
  );
});
