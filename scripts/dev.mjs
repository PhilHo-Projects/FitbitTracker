import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

import dotenv from 'dotenv';
import pg from 'pg';

import { createDevelopmentConfig } from './dev-config.mjs';

const mode = process.argv.includes('--fixtures') ? 'fixtures' : 'live';
if (mode === 'live') {
  const result = dotenv.config({ path: '.env.local' });
  if (result.error) {
    throw new Error('Create .env.local from .env.local.example before running npm run dev');
  }
}

const config = createDevelopmentConfig({ mode, sourceEnv: process.env });

if (config.env.SKIP_LOCAL_DATABASE !== 'true') {
  for (const projectName of config.conflictingComposeProjectNames) {
    const stopped = spawnSync(
      'docker',
      [
        'compose', '-p', projectName,
        '-f', 'docker-compose.dev.yml', 'down', '--remove-orphans',
      ],
      { env: config.env, stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (stopped.status !== 0) {
      throw new Error('Could not switch the local PostgreSQL mode. Start Docker Desktop, then retry npm run dev.');
    }
  }
  const docker = spawnSync(
    'docker',
    config.composeUpArgs,
    { env: config.env, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (docker.status !== 0) {
    throw new Error('Could not start PostgreSQL. Start Docker Desktop, then retry npm run dev.');
  }
}

async function waitForDatabase() {
  const pool = new pg.Pool({ connectionString: config.env.DATABASE_URL });
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
    env: config.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed`);
  }
}

await waitForDatabase();
run('node', ['scripts/migrate.mjs']);
if (config.seedFixtures) run('node', ['scripts/seed.mjs']);
run('npm', ['run', 'build']);

console.log(
  mode === 'live'
    ? 'Starting with the authenticated n8n gateway from .env.local (password: 0000)'
    : 'Starting local fixture mode at http://localhost:3000 (password: 0000)',
);
const child = spawn('node', ['server.js'], { env: config.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
