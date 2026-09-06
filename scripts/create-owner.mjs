import 'dotenv/config';
import { createInterface } from 'node:readline/promises';

import { createAuth, authConstants } from '../lib/auth.js';
import { createPool } from '../lib/db/pool.js';

// --if-missing makes this safe to run on every start: it succeeds quietly when
// an account already exists, and never blocks on a prompt.
const ifMissing = process.argv.includes('--if-missing');

const END_OF_TRANSMISSION = 4;
const INTERRUPT = 3;
const BACKSPACE = 8;
const DELETE = 127;
const FIRST_PRINTABLE = 32;

function ask(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  return rl.question(question).finally(() => rl.close());
}

// Echoes an asterisk per keystroke rather than suppressing output entirely, so
// the prompt visibly responds while the password stays off the screen.
function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return ask(question);

  return new Promise((resolve, reject) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const settle = (finish, result) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      finish(result);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        const code = character.charCodeAt(0);
        if (character === '\r' || character === '\n' || code === END_OF_TRANSMISSION) {
          return settle(resolve, value);
        }
        if (code === INTERRUPT) return settle(reject, new Error('Cancelled'));
        if (code === DELETE || code === BACKSPACE) {
          if (value) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (code >= FIRST_PRINTABLE) {
          value += character;
          stdout.write('*');
        }
      }
      return undefined;
    };

    stdin.on('data', onData);
  });
}

const pool = createPool();
if (!pool) throw new Error('DATABASE_URL is required');
if (!process.env.DASHBOARD_SESSION_SECRET) throw new Error('DASHBOARD_SESSION_SECRET is required');

try {
  const existing = await pool.query('SELECT email FROM "user" ORDER BY "createdAt" LIMIT 1');
  if (existing.rowCount > 0) {
    const message = `An account already exists (${existing.rows[0].email}).`;
    if (ifMissing) console.log(message);
    else {
      console.error(`${message} Refusing to create a second owner.`);
      process.exitCode = 1;
    }
  } else if (ifMissing && !(process.env.DASHBOARD_OWNER_EMAIL && process.env.DASHBOARD_OWNER_PASSWORD)) {
    console.log(
      'No owner account yet. Set DASHBOARD_OWNER_EMAIL and DASHBOARD_OWNER_PASSWORD, ' +
        'or run `npm run auth:create-owner` to be prompted.',
    );
  } else {
    const email = (process.env.DASHBOARD_OWNER_EMAIL || (await ask('Owner email: '))).trim();
    const password = process.env.DASHBOARD_OWNER_PASSWORD || (await askHidden('Owner password: '));

    if (!email) throw new Error('An owner email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`"${email}" is not a full email address, e.g. you@example.com`);
    }
    if (!password) throw new Error('No password was entered');
    if (password.length < authConstants.MIN_PASSWORD_LENGTH) {
      throw new Error(
        `The owner password is ${password.length} characters; it must be at least ${authConstants.MIN_PASSWORD_LENGTH}`,
      );
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
