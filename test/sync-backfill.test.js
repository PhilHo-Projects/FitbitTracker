import assert from 'node:assert/strict';
import test from 'node:test';
import { newDb } from 'pg-mem';
import { applyMigrations } from '../lib/db/migrations.js';
import { runBackfill } from '../scripts/sync-backfill.mjs';

test('backfill rejects missing, reversed and impossible ranges before opening a database', async () => {
  for (const args of [[], ['2026-02-30', '2026-03-02'], ['2026-09-02', '2026-09-01'], ['2026-09-01', '2026-09-01'], ['bad', 'bad']]) {
    await assert.rejects(runBackfill({ args, env: {}, poolFactory: () => assert.fail('must validate first') }), /Usage|valid|range/);
  }
});

test('backfill queues bounded chunks with existing retention rules and closes its pool', async () => {
  const pool = new (newDb({ noAstCoverageCheck: true }).adapters.createPg().Pool)();
  await applyMigrations(pool);
  let closed = false;
  const end = pool.end.bind(pool);
  pool.end = async () => { closed = true; await end(); };
  const job = await runBackfill({ args: ['2026-01-01', '2026-09-05'], env: { RAW_RETENTION_DAYS: '90' }, poolFactory: () => pool,
    now: () => Date.parse('2026-09-05T12:00:00Z'),
    gatewayFactory: () => ({ request: async ({ operation }) => ({ data: operation === 'profile' ? { timezone: 'America/Toronto', membershipStartDate: '2026-01-01' } : { healthUserId: 'fixture-owner' } }) }),
  });
  assert.ok(job.id);
  assert.equal(job.status, 'queued');
  assert.equal(closed, true);
  const chunks = (await pool.query('SELECT metric, start_date, end_date_exclusive FROM sync_chunks')).rows;
  assert.ok(chunks.length > 0);
  const date = (value) => new Date(value).toISOString().slice(0, 10);
  assert.equal(chunks.filter((chunk) => chunk.metric === 'sleep').map((chunk) => date(chunk.start_date)).sort()[0], '2026-01-01');
  assert.ok(chunks.filter((chunk) => chunk.metric === 'heart-rate').every((chunk) => date(chunk.start_date) >= '2026-06-07'));
  assert.ok(chunks.every((chunk) => date(chunk.end_date_exclusive) <= '2026-09-05'));
});

test('backfill closes the database if gateway construction fails', async () => {
  let closed = false;
  await assert.rejects(runBackfill({ args: ['2026-09-01', '2026-09-02'], env: {}, poolFactory: () => ({ end: async () => { closed = true; } }), gatewayFactory: () => { throw new Error('missing gateway'); } }), /missing gateway/);
  assert.equal(closed, true);
});
