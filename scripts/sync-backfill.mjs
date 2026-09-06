import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../lib/db/pool.js';
import { createSyncRepository } from '../lib/jobs/sync-repository.js';
import { createSyncService } from '../lib/jobs/sync-service.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { buildGatewayFromEnv } from './connector-support.mjs';

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function runBackfill({ args = process.argv.slice(2), env = process.env, poolFactory = createPool, gatewayFactory = buildGatewayFromEnv, now = () => Date.now() } = {}) {
  const [startDate, endDateExclusive] = args;
  if (args.length !== 2 || !validDate(startDate) || !validDate(endDateExclusive) || startDate >= endDateExclusive) {
    throw new Error('Usage: npm run sync:backfill -- <start-date> <end-date-exclusive> (valid, increasing dates required)');
  }
  const pool = poolFactory(env);
  if (!pool) throw new Error('DATABASE_URL is required');
  try {
    const gateway = await gatewayFactory(pool, { env });
    if (!gateway) throw new Error('No Google Health sync gateway is configured');
    const service = createSyncService({
      pool, repository: createSyncRepository(pool), gateway,
      writer: createMetricWriter(pool, { compactWritesEnabled: env.HEALTH_COMPACT_WRITES_ENABLED === 'true' }),
      rawRetentionDays: Number(env.RAW_RETENTION_DAYS) || null, now,
    });
    return await service.enqueue({ mode: 'backfill', startDate, endDateExclusive, requestedBy: 'operator-backfill' });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await import('dotenv/config');
  try {
    const job = await runBackfill();
    console.log(`Enqueued backfill job ${job.id} covering ${process.argv[2]} to ${process.argv[3]} (exclusive)`);
  } catch {
    // Database/transport errors can contain connection strings or credentials.
    console.error('Backfill was not enqueued. Check the date range, database, and connector configuration. Usage: npm run sync:backfill -- <start-date> <end-date-exclusive>');
    process.exitCode = 1;
  }
}
