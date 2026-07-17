import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import process from 'node:process';

import dotenv from 'dotenv';
import pg from 'pg';

const live = process.argv.includes('--live');
if (live) {
  const result = dotenv.config({ path: '.env.live' });
  if (result.error) {
    throw new Error('Create .env.live from .env.live.example before running npm run dev:live');
  }
}

const defaults = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgres://health_hub:health_hub_dev@127.0.0.1:54329/health_hub',
  DASHBOARD_PASSWORD: '0000',
  DASHBOARD_SESSION_SECRET: 'local-session-secret-change-before-production',
  JOURNAL_ENCRYPTION_KEYS: `1:${crypto.createHash('sha256').update('health-hub-local-journal-key').digest('base64')}`,
};
const env = { ...process.env, ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !process.env[key])) };

if (env.SKIP_LOCAL_DATABASE !== 'true') {
  const docker = spawnSync(
    'docker',
    ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d', 'postgres'],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (docker.status !== 0) {
    throw new Error('Could not start PostgreSQL. Start Docker Desktop, then retry npm run dev.');
  }
}

async function waitForDatabase() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await pool.query('SELECT 1');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error('PostgreSQL did not become ready within 30 seconds');
  } finally {
    await pool.end();
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

await waitForDatabase();
run('node', ['scripts/migrate.mjs']);
if (!live) run('node', ['scripts/seed.mjs']);
run('npm', ['run', 'build']);

console.log(
  live
    ? 'Starting with the authenticated n8n gateway from .env.live'
    : 'Starting local fixture mode at http://localhost:3000 (password: 0000)',
);
const child = spawn('node', ['server.js'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
