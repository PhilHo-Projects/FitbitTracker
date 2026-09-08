import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createOxygenDatabase, oxygenPoint } from '../test-support/oxygen.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { createSyncRepository } from '../lib/jobs/sync-repository.js';
import { createSyncService } from '../lib/jobs/sync-service.js';
import { buildGoogleHealthRequest } from '../lib/jobs/google-health-request.js';
import { planMetricWindows, DEFAULT_SYNC_METRICS, RAW_SYNC_METRICS } from '../lib/jobs/planner.js';
import { runBackfill } from '../scripts/sync-backfill.mjs';

test('oxygen direct and generated gateway requests agree on list filters and pagination', async () => {
  const workflow = JSON.parse(await readFile(new URL('../n8n/health-hub-workflow.json', import.meta.url)));
  const code = workflow.nodes.find(({ name }) => name === 'Validate and Prepare').parameters.jsCode;
  for (const [metric, field, days] of [
    ['oxygen-saturation', 'oxygen_saturation.sample_time.civil_time', 14],
    ['daily-oxygen-saturation', 'daily_oxygen_saturation.date', 90],
  ]) {
    assert.ok(DEFAULT_SYNC_METRICS.includes(metric));
    const request = { operation: 'list', metric, startDate: '2026-09-01', endDateExclusive: '2026-09-08', pageToken: 'opaque+/=' };
    const direct = buildGoogleHealthRequest(request);
    const generated = runInNewContext(`(function(){${code}})()`, { $input: { first: () => ({ json: { body: request } }) } })[0].json;
    assert.equal(new URL(direct.url).searchParams.get('filter'), `${field} >= "2026-09-01" AND ${field} < "2026-09-08"`);
    assert.equal(new URL(direct.url).searchParams.get('pageSize'), '10000');
    assert.equal(new URL(generated.request.url).searchParams.get('filter'), new URL(direct.url).searchParams.get('filter'));
    assert.equal(new URL(generated.request.url).searchParams.get('pageToken'), 'opaque+/=');
    assert.ok(planMetricWindows({ metric, startDate: '2026-01-01', endDateExclusive: '2026-09-08' }).every((chunk) => chunk.days <= days && chunk.operation === 'list'));
    assert.throws(() => buildGoogleHealthRequest({ ...request, operation: 'reconcile' }), /Unsupported/);
  }
  assert.ok(RAW_SYNC_METRICS.includes('oxygen-saturation'));
  assert.ok(!RAW_SYNC_METRICS.includes('daily-oxygen-saturation'));
});

test('oxygen fetch expands the preceding evening and clamps raw data only', async () => {
  const pool = await createOxygenDatabase();
  let queued;
  const service = createSyncService({ pool, repository: { enqueue: async (job) => { queued = job; return job; } },
    gateway: {}, writer: {}, rawRetentionDays: 90, now: () => Date.parse('2026-09-07T12:00:00Z') });
  await service.enqueue({ mode: 'custom', startDate: '2026-09-07', endDateExclusive: '2026-09-08', metrics: ['oxygen-saturation', 'daily-oxygen-saturation', 'heart-rate'] });
  assert.equal(queued.chunks.find(({ metric }) => metric === 'oxygen-saturation').startDate, '2026-09-06');
  assert.equal(queued.chunks.find(({ metric }) => metric === 'heart-rate').startDate, '2026-09-07');
  assert.equal(queued.chunks.find(({ metric }) => metric === 'daily-oxygen-saturation').startDate, '2026-09-07');
  await service.enqueue({ mode: 'backfill', startDate: '2024-01-01', endDateExclusive: '2026-09-08', metrics: ['oxygen-saturation', 'daily-oxygen-saturation'] });
  assert.equal(queued.chunks.filter(({ metric }) => metric === 'oxygen-saturation').map(({ startDate }) => startDate).sort()[0], '2026-06-10');
  assert.equal(queued.chunks.filter(({ metric }) => metric === 'daily-oxygen-saturation').map(({ startDate }) => startDate).sort()[0], '2024-01-01');
  await assert.rejects(service.enqueue({ mode: 'custom', startDate: '2026-06-09', endDateExclusive: '2026-06-12', metrics: ['oxygen-saturation'] }), { status: 400 });
  await pool.end();
});

test('oxygen persists pages, follows an empty continuation, and leaves no silent null success', async () => {
  const pool = await createOxygenDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const requests = [];
  const gateway = { request: async (request) => {
    requests.push(request.pageToken);
    return requests.length === 1 ? { data: { dataPoints: [oxygenPoint()], nextPageToken: 'two' }, nextPageToken: 'two' }
      : requests.length === 2 ? { data: { nextPageToken: 'three' }, nextPageToken: 'three' } : { data: {} };
  } };
  const service = createSyncService({ pool, repository, gateway, writer: createMetricWriter(pool) });
  const job = await service.enqueue({ mode: 'custom', startDate: '2026-09-07', endDateExclusive: '2026-09-08', metrics: ['oxygen-saturation'] });
  for (let i = 0; i < 3; i++) await service.runOnce();
  assert.deepEqual(requests, [null, 'two', 'three']);
  assert.equal(await repository.jobStatus(job.id), 'completed');
  assert.equal((await pool.query('SELECT * FROM oxygen_saturation_samples')).rows.length, 1);
  gateway.request = async () => ({ data: null });
  const failed = await service.enqueue({ mode: 'custom', startDate: '2026-09-07', endDateExclusive: '2026-09-08', metrics: ['oxygen-saturation'] });
  await service.runOnce();
  assert.equal(await repository.jobStatus(failed.id), 'completed_with_errors');
  assert.match((await pool.query('SELECT last_error FROM sync_chunks WHERE sync_job_id = $1', [failed.id])).rows[0].last_error, /invalid oxygen record/);
  await pool.end();
});

test('terminal oxygen failure preserves successful non-oxygen summaries in either completion order', async () => {
  for (const metrics of [['sleep', 'oxygen-saturation'], ['oxygen-saturation', 'sleep']]) {
    const pool = await createOxygenDatabase();
    const repository = createSyncRepository(pool, { advisoryLocks: false });
    const recalculated = [];
    const service = createSyncService({ pool, repository,
      gateway: { request: async ({ metric }) => {
        if (metric === 'oxygen-saturation') throw Object.assign(new Error('private upstream payload'), { transient: false, status: 403 });
        return { data: {} };
      } },
      writer: { ...createMetricWriter(pool), recalculateDaily: async (_account, date) => recalculated.push(date) },
    });
    const job = await service.enqueue({ mode: 'custom', startDate: '2026-09-07', endDateExclusive: '2026-09-08', metrics });
    await service.runOnce(); await service.runOnce();
    assert.equal(await repository.jobStatus(job.id), 'completed_with_errors');
    assert.deepEqual(recalculated, ['2026-09-07']);
    assert.ok(!(await pool.query('SELECT last_error FROM sync_chunks')).rows.some(({ last_error }) => last_error?.includes('private upstream')));
    await pool.end();
  }
});

test('backfill validates explicit metric selection before connecting and queues only oxygen', async () => {
  for (const selection of ['--metrics=', '--metrics=unknown', '--bad=oxygen-saturation']) {
    await assert.rejects(runBackfill({ args: ['2026-09-01', '2026-09-08', selection], poolFactory: () => assert.fail('must validate before connecting') }), /Usage|metric/);
  }
  const pool = await createOxygenDatabase();
  await runBackfill({ args: ['2026-09-01', '2026-09-08', '--metrics=oxygen-saturation,daily-oxygen-saturation'], env: {},
    poolFactory: () => pool, gatewayFactory: () => ({}) });
  assert.deepEqual(new Set((await pool.query('SELECT metric FROM sync_chunks')).rows.map(({ metric }) => metric)), new Set(['oxygen-saturation', 'daily-oxygen-saturation']));
});

test('stale oxygen claims cannot invoke either terminal finalizer', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const service = createSyncService({ pool, repository, gateway: {}, writer: {} });
  await service.enqueue({ mode: 'custom', startDate: '2026-09-07', endDateExclusive: '2026-09-08', metrics: ['oxygen-saturation'] });
  const chunk = await repository.claimNextChunk('fixture');
  const stale = { ...chunk, claim_token: '11111111-1111-4111-8111-111111111111' };
  assert.equal(await repository.completeChunk(stale, { beforeCommit: () => assert.fail('stale completion') }), false);
  assert.equal((await repository.failChunk(stale, new Error('fixture'), { retryable: false, beforeCommit: () => assert.fail('stale failure') })).stale, true);
});

test('a failed second oxygen page preserves the first page without claiming a complete fetch', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const writer = { ...createMetricWriter(pool), recalculateDaily: () => assert.fail('oxygen-only jobs must not recalculate other metrics') };
  const service = createSyncService({ pool, repository, writer, gateway: { request: async ({ pageToken }) => pageToken
    ? { data: { dataPoints: null } }
    : { data: { dataPoints: [oxygenPoint()], nextPageToken: 'second' }, nextPageToken: 'second' } } });
  const job = await service.enqueue({ mode: 'custom', startDate: '2026-09-07', endDateExclusive: '2026-09-08', metrics: ['oxygen-saturation'] });
  await service.runOnce(); await service.runOnce();
  assert.equal(await repository.jobStatus(job.id), 'completed_with_errors');
  assert.equal((await pool.query('SELECT * FROM oxygen_saturation_samples')).rows.length, 1);
  const { createOxygenRepository } = await import('../lib/db/oxygen-repository.js');
  const day = await createOxygenRepository(pool).getDay('75ce6554-70c7-48be-a688-d0079384fcb1', '2026-09-06');
  assert.equal(day.sync.intraday.fetchComplete, false);
  assert.equal(day.sync.intraday.lastAttemptStatus, 'failed');
  assert.equal(day.samples.length, 1);
});
