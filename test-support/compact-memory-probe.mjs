import pg from 'pg';
import { runCompactHealthOperation } from '../lib/db/compact-backfill.js';

const schema = process.env.COMPACT_PROBE_SCHEMA;
if (!/^health_archive_integration_[a-f0-9]{32}$/.test(schema ?? '')) throw new Error('Expected an isolated test schema');
const pool = new pg.Pool({ connectionString: process.env.PG_INTEGRATION_URL, max: 1,
  options: `-c search_path=${schema} -c default_transaction_read_only=on -c statement_timeout=60000` });
try {
  const result = await runCompactHealthOperation({ pool, mode: 'backfill', batchSize: 1000 });
  console.log(JSON.stringify({ rows: result.sourceRows.heart, maxRssKiB: process.resourceUsage().maxRSS }));
} finally { await pool.end(); }
