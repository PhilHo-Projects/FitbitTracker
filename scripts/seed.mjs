import 'dotenv/config';

import { seedFixtures } from '../lib/db/fixtures.js';
import { createPool } from '../lib/db/pool.js';

const pool = createPool();
if (!pool) throw new Error('DATABASE_URL is required');

try {
  const result = await seedFixtures(pool, {
    anchorDate: process.env.FIXTURE_ANCHOR_DATE || new Date().toISOString().slice(0, 10),
  });
  console.log(`Seeded deterministic fixtures through ${result.anchorDate}`);
} finally {
  await pool.end();
}
