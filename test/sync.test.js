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

test('manual-only worker polls queued jobs without creating a scheduled sync interval', async () => {
  const timeouts = [];
  const intervals = [];
  const service = createSyncService({
    pool: {},
    repository: {
      recoverStaleClaims: async () => {},
      claimNextChunk: async () => null,
    },
    gateway: {},
    writer: {},
    timers: {
      setTimeout: (callback, delay) => (timeouts.push({ callback, delay }), timeouts.length),
      clearTimeout: () => {},
      setInterval: (callback, delay) => (intervals.push({ callback, delay }), intervals.length),
      clearInterval: () => {},
    },
  });

  service.start({ scheduleEnabled: false });
  await new Promise(setImmediate);

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, 0);
  assert.equal(intervals.length, 0);
  service.stop();
});

test('scheduled sync uses the configured interval and a bounded recent lookback', async () => {
  const pool = await createDatabase();
  const intervals = [];
  const service = createSyncService({
    pool,
    repository: createSyncRepository(pool, { advisoryLocks: false }),
    gateway: { request: async () => ({ ok: true, data: {} }) },
    writer: createMetricWriter(pool),
    now: () => Date.parse('2026-07-17T02:00:00.000Z'),
    timers: {
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: (callback, delay) => (intervals.push({ callback, delay }), intervals.length),
      clearInterval: () => {},
    },
  });

  service.start({
    scheduleEnabled: true,
    syncIntervalMs: 6 * 60 * 60 * 1000,
    scheduledLookbackDays: 2,
  });
  intervals[0].callback();
  let job;
  for (let attempt = 0; attempt < 20 && !job; attempt += 1) {
    await new Promise(setImmediate);
    job = (await service.status()).active[0];
  }

  assert.equal(intervals[0].delay, 6 * 60 * 60 * 1000);
  assert.equal(job.startDate, '2026-07-15');
  assert.equal(job.endDateExclusive, '2026-07-17');
  service.stop();
  await pool.end();
});

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
  const totalCalories = planMetricWindows({
    metric: 'total-calories',
    startDate: '2026-07-10',
    endDateExclusive: '2026-07-17',
  });

  assert.equal(heart[0].endDateExclusive, '2026-07-17');
  assert.equal(heart[0].startDate, '2026-07-03');
  assert.ok(heart.every((window) => window.days <= 14));
  assert.ok(sleep.every((window) => window.days <= 90));
  assert.equal(sleep.at(-1).startDate, '2026-01-01');
  assert.ok(totalCalories.every((window) => window.days === 1));
  assert.ok(totalCalories.every((window) => window.operation === 'rollUp'));
});

test('default sync omits the currently unavailable Google total-calories rollup', () => {
  const chunks = planSyncChunks({
    startDate: '2026-07-16',
    endDateExclusive: '2026-07-17',
  });

  assert.deepEqual(
    [...new Set(chunks.map(({ metric }) => metric))],
    [
      'sleep',
      'heart-rate',
      'daily-resting-heart-rate',
      'active-energy-burned',
      'basal-energy-burned',
    ],
  );
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

test('retained backfills keep full sleep history while clamping high-volume raw metrics', async () => {
  const pool = await createDatabase();
  const service = createSyncService({
    pool,
    repository: createSyncRepository(pool, { advisoryLocks: false }),
    gateway: { request: async () => ({ ok: true, data: {} }) },
    writer: createMetricWriter(pool),
    rawRetentionDays: 90,
    now: () => Date.parse('2026-07-17T16:00:00.000Z'),
  });

  await service.enqueue({
    mode: 'backfill',
    startDate: '2026-01-01',
    endDateExclusive: '2026-07-18',
    metrics: [
      'sleep',
      'heart-rate',
      'daily-resting-heart-rate',
      'active-energy-burned',
      'basal-energy-burned',
    ],
  });

  const chunks = (await pool.query('SELECT metric, start_date FROM sync_chunks')).rows;
  const earliest = (metric) =>
    chunks
      .filter((chunk) => chunk.metric === metric)
      .map((chunk) => new Date(chunk.start_date).toISOString().slice(0, 10))
      .sort()[0];

  assert.equal(earliest('sleep'), '2026-01-01');
  assert.equal(earliest('daily-resting-heart-rate'), '2026-01-01');
  assert.equal(earliest('heart-rate'), '2026-04-19');
  assert.equal(earliest('active-energy-burned'), '2026-04-19');
  assert.equal(earliest('basal-energy-burned'), '2026-04-19');
  await pool.end();
});

test('retention rejects custom raw ranges older than the configured cutoff', async () => {
  const pool = await createDatabase();
  const service = createSyncService({
    pool,
    repository: createSyncRepository(pool, { advisoryLocks: false }),
    gateway: { request: async () => ({ ok: true, data: {} }) },
    writer: createMetricWriter(pool),
    rawRetentionDays: 90,
    now: () => Date.parse('2026-07-17T16:00:00.000Z'),
  });

  await assert.rejects(
    () =>
      service.enqueue({
        mode: 'custom',
        startDate: '2026-01-01',
        endDateExclusive: '2026-01-02',
        metrics: ['heart-rate'],
      }),
    (error) => error.status === 400 && /90-day raw retention/.test(error.message),
  );
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
  await gateway.request({
    operation: 'rollUp',
    metric: 'total-calories',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    pageToken: null,
    timezone: 'America/Toronto',
  });
  await assert.rejects(
    () => gateway.request({ operation: 'delete', metric: 'heart-rate' }),
    /Unsupported gateway request/,
  );
  await assert.rejects(
    () =>
      gateway.request({
        operation: 'dailyRollup',
        metric: 'total-calories',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-17',
      }),
    /Unsupported gateway request/,
  );

  assert.equal(response.nextPageToken, 'next');
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    pageToken: null,
  });
  assert.equal(calls[0].options.headers['x-fitness-token'], 'secret');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    operation: 'rollUp',
    metric: 'total-calories',
    startDate: '2026-07-03',
    endDateExclusive: '2026-07-17',
    pageToken: null,
    timezone: 'America/Toronto',
  });
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

test('production claim locks only the chunk row when the claim lookup uses an outer join', async () => {
  const queries = [];
  const repository = createSyncRepository({
    async connect() {
      return {
        async query(text) {
          queries.push(text);
          return { rows: [] };
        },
        release() {},
      };
    },
  });

  assert.equal(await repository.claimNextChunk('worker-1'), null);
  const claimQuery = queries.find((query) => String(query).includes('FROM sync_chunks chunk'));
  assert.match(claimQuery, /FOR UPDATE OF chunk SKIP LOCKED/);
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

test('a stale worker cannot finish or release a reclaimed chunk lease', async () => {
  const pool = await createDatabase();
  let clock = Date.now();
  const repository = createSyncRepository(pool, {
    advisoryLocks: false,
    now: () => clock,
  });
  await repository.enqueue(
    syncRequest([
      {
        metric: 'heart-rate',
        operation: 'list',
        startDate: '2026-07-03',
        endDateExclusive: '2026-07-17',
        pageToken: null,
      },
    ]),
  );

  const first = await repository.claimNextChunk('worker-a');
  const claimedAt = (await pool.query('SELECT claimed_at FROM sync_chunks WHERE id = $1', [first.id]))
    .rows[0].claimed_at;
  clock = new Date(claimedAt).getTime() + 16 * 60 * 1000;
  await repository.recoverStaleClaims();
  const second = await repository.claimNextChunk('worker-b');

  assert.equal(second.id, first.id);
  assert.notEqual(second.claim_token, first.claim_token);
  assert.equal(await repository.completeChunk(first, { nextPageToken: null }), false);
  assert.deepEqual(await repository.failChunk(first, new Error('late failure')), {
    retry: false,
    stale: true,
  });

  const current = (
    await pool.query('SELECT status, claimed_by, claim_token FROM sync_chunks WHERE id = $1', [first.id])
  ).rows[0];
  const accountClaim = (
    await pool.query(
      'SELECT sync_chunk_id, claim_token FROM sync_account_claims WHERE source_account_id = $1',
      [first.source_account_id],
    )
  ).rows[0];
  assert.deepEqual(current, {
    status: 'running',
    claimed_by: 'worker-b',
    claim_token: second.claim_token,
  });
  assert.deepEqual(accountClaim, {
    sync_chunk_id: second.id,
    claim_token: second.claim_token,
  });
  assert.equal(await repository.completeChunk(second, { nextPageToken: null }), true);
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

test('sync worker ingests a chunk, finalizes its window, and completes the job', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const gatewayRequests = [];
  const service = createSyncService({
    pool,
    repository,
    writer: createMetricWriter(pool),
    gateway: {
      request: async (request) => {
        gatewayRequests.push(request);
        return {
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
        };
      },
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
  assert.equal(gatewayRequests[0].startDate, '2026-07-16');
  assert.equal(gatewayRequests[0].endDateExclusive, '2026-07-17');
  assert.equal(gatewayRequests[0].timezone, 'America/Toronto');

  await pool.end();
});

test('raw retention alone never authorizes deletion', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const baseWriter = createMetricWriter(pool);
  const prunes = [];
  const writer = {
    ...baseWriter,
    async pruneRawMetricsBefore(sourceAccountId, cutoffDate) {
      prunes.push({ sourceAccountId, cutoffDate });
      return baseWriter.pruneRawMetricsBefore(sourceAccountId, cutoffDate);
    },
  };
  const service = createSyncService({
    pool,
    repository,
    writer,
    gateway: {
      request: async () => ({ ok: true, data: { dataPoints: [] }, nextPageToken: null }),
    },
    rawRetentionDays: 90,
    now: () => Date.parse('2026-07-17T16:00:00.000Z'),
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-17',
    endDateExclusive: '2026-07-18',
    metrics: ['sleep', 'heart-rate'],
  });
  await service.runOnce();
  assert.equal(prunes.length, 0);
  await service.runOnce();
  assert.equal(prunes.length, 0);
  await pool.end();
});

test('explicit raw pruning runs only after every chunk completes', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const baseWriter = createMetricWriter(pool);
  const prunes = [];
  const service = createSyncService({
    pool,
    repository,
    writer: {
      ...baseWriter,
      async pruneRawMetricsBefore(sourceAccountId, cutoffDate) {
        prunes.push({ sourceAccountId, cutoffDate });
        return baseWriter.pruneRawMetricsBefore(sourceAccountId, cutoffDate);
      },
    },
    gateway: {
      request: async () => ({ ok: true, data: { dataPoints: [] }, nextPageToken: null }),
    },
    rawRetentionDays: 90,
    rawPruningEnabled: true,
    now: () => Date.parse('2026-07-17T16:00:00.000Z'),
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-17',
    endDateExclusive: '2026-07-18',
    metrics: ['sleep', 'heart-rate'],
  });
  await service.runOnce();
  assert.equal(prunes.length, 0);
  await service.runOnce();
  assert.deepEqual(prunes.map(({ cutoffDate }) => cutoffDate), ['2026-04-19']);
  await pool.end();
});

test('a two-page sync defers each daily finalization until the last provider page', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const baseWriter = createMetricWriter(pool);
  const finalized = [];
  const writer = {
    ...baseWriter,
    async recalculateDaily(sourceAccountId, date, database) {
      finalized.push({ sourceAccountId, date, database });
      return baseWriter.recalculateDaily(sourceAccountId, date, database);
    },
  };
  let page = 0;
  const service = createSyncService({
    pool,
    repository,
    writer,
    gateway: {
      async request() {
        page += 1;
        const civilDate = page === 1 ? '2026-07-16' : '2026-07-17';
        return {
          data: {
            dataPoints: [{
              dataPointName: `heart-${civilDate}`,
              heartRate: {
                samples: [{
                  sampleTime: `${civilDate}T12:00:00Z`,
                  utcOffset: '-14400s',
                  beatsPerMinute: 70 + page,
                }],
              },
            }],
          },
          nextPageToken: page === 1 ? 'page-2' : null,
        };
      },
    },
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-16',
    endDateExclusive: '2026-07-18',
    metrics: ['heart-rate'],
  });
  await service.runOnce();
  assert.deepEqual(finalized, []);
  await service.runOnce();
  assert.deepEqual(finalized.map(({ date }) => date), ['2026-07-16', '2026-07-17']);
  assert.equal(finalized.every(({ database }) => typeof database?.query === 'function'), true);
  assert.equal(finalized[0].database, finalized[1].database);
  await pool.end();
});

test('a finalization failure rolls back summaries and fails the last chunk', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const baseWriter = createMetricWriter(pool);
  const service = createSyncService({
    pool,
    repository,
    writer: {
      ...baseWriter,
      async recalculateDaily() {
        throw Object.assign(new Error('summary finalization failed'), { transient: false });
      },
    },
    gateway: {
      async request() {
        return {
          data: {
            dataPoints: [{
              dataPointName: 'heart-finalization-failure',
              heartRate: {
                samples: [{
                  sampleTime: '2026-07-16T12:00:00Z',
                  utcOffset: '-14400s',
                  beatsPerMinute: 71,
                }],
              },
            }],
          },
          nextPageToken: null,
        };
      },
    },
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-16',
    endDateExclusive: '2026-07-17',
    metrics: ['heart-rate'],
  });
  await service.runOnce();

  assert.equal((await service.status()).recent[0].status, 'completed_with_errors');
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) AS count FROM heart_rate_daily_summaries')).rows[0].count),
    0,
  );
  await pool.end();
});

test('failed sync jobs preserve raw rows for a later retry', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const baseWriter = createMetricWriter(pool);
  let pruneCalls = 0;
  const service = createSyncService({
    pool,
    repository,
    writer: {
      ...baseWriter,
      async pruneRawMetricsBefore(...args) {
        pruneCalls += 1;
        return baseWriter.pruneRawMetricsBefore(...args);
      },
    },
    gateway: {
      request: async () => {
        throw Object.assign(new Error('permanent gateway failure'), { transient: false });
      },
    },
    rawRetentionDays: 90,
    now: () => Date.parse('2026-07-17T16:00:00.000Z'),
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-17',
    endDateExclusive: '2026-07-18',
    metrics: ['heart-rate'],
  });
  await service.runOnce();

  assert.equal((await service.status()).recent[0].status, 'completed_with_errors');
  assert.equal(pruneCalls, 0);
  await pool.end();
});

test('sync worker converts PostgreSQL date objects before filtering sleep records', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const service = createSyncService({
    pool,
    repository,
    writer: createMetricWriter(pool),
    gateway: {
      request: async () => ({
        ok: true,
        metric: 'sleep',
        status: 200,
        data: {
          dataPoints: [
            {
              dataPointName: 'worker-sleep',
              sleep: {
                interval: {
                  startTime: '2026-07-17T03:00:00Z',
                  endTime: '2026-07-17T11:00:00Z',
                  startUtcOffset: '-14400s',
                  endUtcOffset: '-14400s',
                  civilEndTime: {
                    date: { year: 2026, month: 7, day: 17 },
                    time: { hours: 7 },
                  },
                },
                type: 'STAGES',
                metadata: { nap: false, processed: true, stagesStatus: 'SUCCEEDED' },
                summary: {
                  minutesInSleepPeriod: '480',
                  minutesAsleep: '450',
                  minutesAwake: '30',
                  stagesSummary: [],
                },
                stages: [],
              },
            },
          ],
        },
        nextPageToken: null,
      }),
    },
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-17',
    endDateExclusive: '2026-07-18',
    metrics: ['sleep'],
    requestedBy: 'test',
  });
  await service.runOnce();

  const sessions = await pool.query('SELECT provider_key, civil_date FROM sleep_sessions');
  assert.equal(sessions.rowCount, 1);
  assert.equal(sessions.rows[0].provider_key, 'worker-sleep');
  assert.equal(new Date(sessions.rows[0].civil_date).toISOString().slice(0, 10), '2026-07-17');
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
