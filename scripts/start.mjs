import { spawn } from 'node:child_process';

import { applyMigrations } from '../lib/db/migrations.js';
import { createPool } from '../lib/db/pool.js';

const pool = createPool();
if (!pool) throw new Error('DATABASE_URL is required');

try {
  const executed = await applyMigrations(pool);
  if (executed.length) console.log(`Applied migrations: ${executed.join(', ')}`);
} finally {
  await pool.end();
}

const child = spawn(process.execPath, ['server.js'], {
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
