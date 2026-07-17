import 'dotenv/config';

import { applyMigrations } from '../lib/db/migrations.js';
import { createPool } from '../lib/db/pool.js';

const pool = createPool();
if (!pool) throw new Error('DATABASE_URL is required');

try {
  const applied = await applyMigrations(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is current');
} finally {
  await pool.end();
}
