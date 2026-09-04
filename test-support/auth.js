import { newDb } from 'pg-mem';

import { createAuth } from '../lib/auth.js';
import { applyMigrations } from '../lib/db/migrations.js';

export const OWNER_EMAIL = 'owner@example.test';
export const OWNER_PASSWORD = 'correct horse battery staple';

// Builds a Better Auth instance backed by an in-memory database with the
// single owner account already seeded. The instance is injected into
// createApp() as `auth` so the app itself stays database-free.
export async function createTestAuth(env) {
  const memory = newDb({ noAstCoverageCheck: true });
  const pool = new (memory.adapters.createPg().Pool)();
  await applyMigrations(pool);

  const seeder = createAuth({ pool, env, allowSignUp: true });
  await seeder.api.signUpEmail({
    body: { email: OWNER_EMAIL, password: OWNER_PASSWORD, name: 'Owner' },
  });

  return { auth: createAuth({ pool, env }), pool };
}

// Better Auth rejects state-changing requests without an Origin header, the
// same way a browser always supplies one on a same-origin POST.
export function signIn(baseUrl, { email = OWNER_EMAIL, password = OWNER_PASSWORD } = {}) {
  return fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email, password }),
  });
}

export async function signInCookie(baseUrl, credentials) {
  const response = await signIn(baseUrl, credentials);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`Sign-in failed with HTTP ${response.status}`);
  return cookie.split(';')[0];
}
