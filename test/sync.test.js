import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { createGoogleHealthGateway } from '../lib/jobs/google-health-gateway.js';
import { planMetricWindows, planSyncChunks } from '../lib/jobs/planner.js';
import { createSyncRepository } from '../lib/jobs/sync-repository.js';
import { createSyncService } from '../lib/jobs/sync-service.js';

async function createDatabase() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  await pool.query(
    `INSERT INTO source_accounts (
      id, provider, provider_account_id, timezone, membership_start_date
    ) VALUES (
      '75ce6554-70c7-48be-a688-d0079384fcb1', 'google-health', 'test', 'America/Toronto', '2026-01-01'
    )`,
  );
  return pool;
}

async function createEmptyDatabase() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  return pool;
}

function delayActiveJobReads(pool, expectedReads) {
  let reads = 0;
  let release;
  const allReadsStarted = new Promise((resolve) => {
    release = resolve;
  });

  return {
    ...pool,
    async connect() {
      const client = await pool.connect();
      let inTransaction = false;
      return {
        ...client,
        async query(text, values) {
          const result = await client.query(text, values);
          if (text === 'BEGIN') inTransaction = true;
          if (text === 'COMMIT' || text === 'ROLLBACK') inTransaction = false;
          if (
            inTransaction &&
            typeof text === 'string' &&
            text.includes('SELECT * FROM sync_jobs') &&
            text.includes("status IN ('queued', 'running')")
          ) {
            reads += 1;
            if (reads === expectedReads) release();
            await allReadsStarted;
          }
          return result;
        },
        release: client.release.bind(client),
      };
    },
  };
}

function syncRequest(chunks) {
  return {
    sourceAccountId: '75ce6554-70c7-48be-a688-d0079384fcb1',
    jobType: 'incremental',
    requestedBy: 'test',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    metrics: ['heart-rate'],
    chunks,
  };
}

test('sync planner respects metric limits and schedules recent windows first', () => {
  const heart = planMetricWindows({
    metric: 'heart-rate',
    startDate: '2026-06-01',
    endDateExclusive: '2026-07-17',
  });
  const sleep = planMetricWindows({
    metric: 'sleep',
    startDate: '2026-01-01',
    endDateExclusive: '2026-07-17',
  });

  assert.equal(heart[0].endDateExclusive, '2026-07-17');
  assert.equal(heart[0].startDate, '2026-07-03');
  assert.ok(heart.every((window) => window.days <= 14));
  assert.ok(sleep.every((window) => window.days <= 90));
  assert.equal(sleep.at(-1).startDate, '2026-01-01');
});

test('multi-metric backfills prioritize the newest window for every metric before older history', () => {
  const chunks = planSyncChunks({
    metrics: ['sleep', 'heart-rate', 'active-energy-burned'],
    startDate: '2025-01-01',
    endDateExclusive: '2026-07-17',
  });
  const firstOlderWindow = chunks.findIndex(
    ({ endDateExclusive }) => endDateExclusive !== '2026-07-17',
  );

  assert.deepEqual(
    chunks.slice(0, firstOlderWindow).map(({ metric }) => metric),
    ['sleep', 'heart-rate', 'active-energy-burned'],
  );
  assert.ok(
    chunks
      .slice(firstOlderWindow)
      .every(
        ({ endDateExclusive }, index, older) =>
          index === 0 || endDateExclusive <= older[index - 1].endDateExclusive,
      ),
  );
});

test('automatic sync ranges use the source civil date rather than UTC midnight', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const service = createSyncService({
    pool,
    repository,
    gateway: { request: async () => ({ ok: true, data: {} }) },
    writer: createMetricWriter(pool),
    now: () => Date.parse('2026-07-17T02:00:00.000Z'),
  });

  const job = await service.enqueue({
    mode: 'recent',
    metrics: ['heart-rate'],
    requestedBy: 'test',
  });

  assert.equal(job.endDateExclusive, '2026-07-17');
  assert.equal(job.startDate, '2026-07-10');
  await pool.end();
});

test('sync requests reject unsupported metrics and invalid closed-open ranges', async () => {
  const pool = await createDatabase();
  const service = createSyncService({
    pool,
    repository: createSyncRepository(pool, { advisoryLocks: false }),
    gateway: { request: async () => ({ ok: true, data: {} }) },
    writer: createMetricWriter(pool),
  });

  await assert.rejects(
    () =>
      service.enqueue({
        mode: 'custom',
        startDate: '2026-07-17',
        endDateExclusive: '2026-07-17',
        metrics: ['heart-rate'],
      }),
    (error) => error.status === 400 && /closed-open/.test(error.message),
  );
  await assert.rejects(
    () =>
      service.enqueue({
        mode: 'custom',
        startDate: '2026-07-16',
        endDateExclusive: '2026-07-17',
        metrics: ['steps'],
      }),
    (error) => error.status === 400 && /supported metric/.test(error.message),
  );

  assert.equal((await pool.query('SELECT COUNT(*) AS count FROM sync_jobs')).rows[0].count, 0);
  await pool.end();
});

test('gateway enforces the allow-list and forwards the bounded request contract', async () => {
  const calls = [];
  const gateway = createGoogleHealthGateway({
    url: 'https://n8n.example.test/webhook/fitness-sync',
    token: 'secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          ok: true,
          metric: 'heart-rate',
          status: 200,
          data: { dataPoints: [] },
          nextPageToken: 'next',
          requestId: 'request-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const response = await gateway.request({
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    pageToken: null,
  });
  await assert.rejects(
    () => gateway.request({ operation: 'delete', metric: 'heart-rate' }),
    /Unsupported gateway request/,
  );
  await assert.rejects(
    () =>
      gateway.request({
        operation: 'dailyRollup',
        metric: 'heart-rate',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-17',
      }),
    /Unsupported gateway request/,
  );

  assert.equal(response.nextPageToken, 'next');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    pageToken: null,
  });
  assert.equal(calls[0].options.headers['x-fitness-token'], 'secret');
});

test('gateway preserves tunneled Google status codes so transient failures retry', async () => {
  const gateway = createGoogleHealthGateway({
    url: 'https://n8n.example.test/webhook/fitness-sync',
    token: 'secret',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: false,
          metric: 'heart-rate',
          status: 503,
          data: null,
          nextPageToken: null,
          requestId: 'request-failed',
          message: 'Google Health unavailable',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  await assert.rejects(
    () =>
      gateway.request({
        operation: 'list',
        metric: 'heart-rate',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-17',
      }),
    (error) => error.status === 503 && error.transient === true,
  );
});

test('persistent chunks checkpoint pagination and prevent overlapping active jobs', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const request = {
    sourceAccountId: '75ce6554-70c7-48be-a688-d0079384fcb1',
    jobType: 'incremental',
    requestedBy: 'test',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    metrics: ['heart-rate'],
    chunks: [
      {
        metric: 'heart-rate',
        operation: 'list',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-17',
        pageToken: null,
      },
    ],
  };
  const first = await repository.enqueue(request);
  const duplicate = await repository.enqueue(request);
  const claimed = await repository.claimNextChunk('worker-1');
  const unavailable = await repository.claimNextChunk('worker-2');

  assert.equal(duplicate.id, first.id);
  assert.equal(claimed.status, 'running');
  assert.equal(unavailable, null);

  await repository.completeChunk(claimed, { nextPageToken: 'page-2' });
  const next = await repository.claimNextChunk('worker-1');
  assert.equal(next.page_token, 'page-2');
  await repository.completeChunk(next, { nextPageToken: null });

  const status = await repository.status();
  assert.equal(status.recent[0].status, 'completed');
  assert.equal(status.recent[0].completedChunks, 2);

  await pool.end();
});

test('simultaneous enqueue attempts share one active job', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(delayActiveJobReads(pool, 2), { advisoryLocks: false });
  const request = syncRequest([
    {
      metric: 'heart-rate',
      operation: 'list',
      startDate: '2026-07-03',
      endDateExclusive: '2026-07-17',
      pageToken: null,
    },
  ]);

  const [first, second] = await Promise.all([repository.enqueue(request), repository.enqueue(request)]);
  const active = await pool.query(
    "SELECT id FROM sync_jobs WHERE status IN ('queued', 'running') ORDER BY created_at",
  );

  assert.equal(active.rowCount, 1);
  assert.equal(second.id, first.id);
  await pool.end();
});

test('only one chunk per source account runs until it completes or requeues', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  await repository.enqueue(
    syncRequest([
      {
        metric: 'heart-rate',
        operation: 'list',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-10',
        pageToken: null,
      },
      {
        metric: 'heart-rate',
        operation: 'list',
        startDate: '2026-07-10',
        endDateExclusive: '2026-07-17',
        pageToken: null,
      },
    ]),
  );

  const first = await repository.claimNextChunk('worker-1');
  assert.equal((await repository.claimNextChunk('worker-2')), null);

  await repository.completeChunk(first, { nextPageToken: null });
  const second = await repository.claimNextChunk('worker-2');
  assert.ok(second);
  assert.notEqual(second.id, first.id);

  await repository.failChunk(second, new Error('retry'), { delayMs: 0 });
  const requeued = await repository.claimNextChunk('worker-3');
  assert.equal(requeued.id, second.id);
  await pool.end();
});

test('stale running chunks are requeued so a restarted worker resumes safely', async () => {
  const pool = await createDatabase();
  let clock = Date.now();
  const repository = createSyncRepository(pool, {
    advisoryLocks: false,
    now: () => clock,
  });
  const request = {
    sourceAccountId: '75ce6554-70c7-48be-a688-d0079384fcb1',
    jobType: 'incremental',
    requestedBy: 'test',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    metrics: ['heart-rate'],
    chunks: [
      {
        metric: 'heart-rate',
        operation: 'list',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-17',
        pageToken: null,
      },
    ],
  };
  await repository.enqueue(request);
  const abandoned = await repository.claimNextChunk('worker-before-restart');
  const claimedAt = (
    await pool.query('SELECT claimed_at FROM sync_chunks WHERE id = $1', [abandoned.id])
  ).rows[0].claimed_at;
  clock = new Date(claimedAt).getTime() + 16 * 60 * 1000;

  const recovery = await repository.recoverStaleClaims();
  const resumed = await repository.claimNextChunk('worker-after-restart');

  assert.equal(recovery.chunks, 1);
  assert.equal(resumed.id, abandoned.id);
  assert.equal(resumed.attempt_count, 2);
  await pool.end();
});

test('sync worker ingests a chunk, recalculates its day, and completes the job', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const service = createSyncService({
    pool,
    repository,
    writer: createMetricWriter(pool),
    gateway: {
      request: async () => ({
        ok: true,
        metric: 'heart-rate',
        status: 200,
        data: {
          dataPoints: [
            {
              dataPointName: 'worker-heart',
              heartRate: {
                samples: [
                  {
                    sampleTime: '2026-07-16T12:00:00Z',
                    utcOffset: '-14400s',
                    beatsPerMinute: 71,
                  },
                  {
                    sampleTime: '2026-07-16T12:05:00Z',
                    utcOffset: '-14400s',
                    beatsPerMinute: 73,
                  },
                ],
              },
            },
          ],
        },
        nextPageToken: null,
        requestId: 'request-worker',
      }),
    },
    workerId: 'worker-test',
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-16',
    endDateExclusive: '2026-07-17',
    metrics: ['heart-rate'],
    requestedBy: 'test',
  });
  assert.equal(await service.runOnce(), true);

  const samples = await pool.query('SELECT beats_per_minute FROM heart_rate_samples ORDER BY sampled_at');
  const daily = (await pool.query('SELECT average_bpm FROM heart_rate_daily_summaries')).rows[0];
  const status = await service.status();

  assert.deepEqual(samples.rows.map(({ beats_per_minute: bpm }) => Number(bpm)), [71, 73]);
  assert.equal(Number(daily.average_bpm), 72);
  assert.equal(status.recent[0].status, 'completed');

  await pool.end();
});

test('first sync bootstraps the source account from profile membership date and identity', async () => {
  const pool = await createEmptyDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const gateway = {
    request: async ({ operation }) =>
      operation === 'profile'
        ? {
            ok: true,
            data: {
              name: 'users/me/profile',
              membershipStartDate: { year: 2024, month: 2, day: 3 },
            },
          }
        : { ok: true, data: { healthUserId: 'google-health-user-1' } },
  };
  const service = createSyncService({
    pool,
    repository,
    gateway,
    writer: createMetricWriter(pool),
    workerId: 'worker-bootstrap',
  });

  const job = await service.enqueue({
    mode: 'backfill',
    endDateExclusive: '2026-07-17',
    metrics: ['sleep'],
    requestedBy: 'test',
  });
  const account = (await pool.query('SELECT * FROM source_accounts')).rows[0];

  assert.equal(account.provider_account_id, 'google-health-user-1');
  assert.equal(new Date(account.membership_start_date).toISOString().slice(0, 10), '2024-02-03');
  assert.equal(job.startDate, '2024-02-03');

  await pool.end();
});
