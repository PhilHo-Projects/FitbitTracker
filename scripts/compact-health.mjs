import process from 'node:process';

import {
  parseCompactHealthArgs,
  runCompactHealthOperation,
} from '../lib/db/compact-backfill.js';
import { createPool } from '../lib/db/pool.js';

const pool = createPool();
if (!pool) {
  console.error('DATABASE_URL is required for compact health validation or backfill');
  process.exitCode = 1;
} else {
  try {
    const options = parseCompactHealthArgs(process.argv.slice(2), {
      defaultBatchSize: process.env.HEALTH_COMPACT_BACKFILL_BATCH_SIZE || 1000,
    });
    const result = await runCompactHealthOperation({ pool, ...options });
    console.log(JSON.stringify(result, null, 2));
    if (result.validation && !result.validation.valid) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
