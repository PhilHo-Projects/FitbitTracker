import 'dotenv/config';
import { createInterface } from 'node:readline/promises';

import { createAuth, authConstants } from '../lib/auth.js';
import { createPool } from '../lib/db/pool.js';

function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl.output.write.bind(rl.output);
  let muted = false;
  rl.output.write = (chunk, ...rest) => (muted ? true : write(chunk, ...rest));

  const answer = rl.question(question);
  muted = hidden;
  return answer.finally(() => {
    muted = false;
    if (hidden) write('\n');
    rl.close();
  });
}

const pool = createPool();
if (!pool) throw new Error('DATABASE_URL is required');
if (!process.env.DASHBOARD_SESSION_SECRET) throw new Error('DASHBOARD_SESSION_SECRET is required');

try {
  const existing = await pool.query('SELECT email FROM "user" ORDER BY "createdAt" LIMIT 1');
  if (existing.rowCount > 0) {
    console.error(`An account already exists (${existing.rows[0].email}). Refusing to create a second owner.`);
    process.exitCode = 1;
  } else {
    const email = (process.env.DASHBOARD_OWNER_EMAIL || (await ask('Owner email: '))).trim();
    const password = process.env.DASHBOARD_OWNER_PASSWORD || (await ask('Owner password: ', { hidden: true }));
    if (!email) throw new Error('An owner email is required');
    if (password.length < authConstants.MIN_PASSWORD_LENGTH) {
      throw new Error(`The owner password must be at least ${authConstants.MIN_PASSWORD_LENGTH} characters`);
    }

    // Sign-up stays disabled on the running server; this script is the only
    // path that may create the single owner account.
    const auth = createAuth({ pool, allowSignUp: true });
    const created = await auth.api.signUpEmail({
      body: { email, password, name: process.env.DASHBOARD_OWNER_NAME || 'Owner' },
    });
    console.log(`Created owner account ${created.user.email}`);
  }
} finally {
  await pool.end();
}
