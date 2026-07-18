import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { createApp } from '../server.js';

const env = {
  NODE_ENV: 'test',
  DASHBOARD_PASSWORD: 'correct horse battery staple',
  DASHBOARD_SESSION_SECRET: 'test-session-secret-that-is-long-enough',
};

const dashboard = {
  date: '2026-07-16',
  timezone: 'America/Toronto',
  sleep: { durationMinutes: 397 },
  heart: { restingBpm: 58 },
  calories: { totalKcal: 2448 },
};

function services() {
  const journalEntries = [];
  const exportJobs = [];
  return {
    healthRepository: {
      getDashboard: async () => dashboard,
      getSleepRange: async (startDate, endDateExclusive) => ({ startDate, endDateExclusive, sessions: [] }),
      getHeartRange: async (startDate, endDateExclusive, resolution) => ({
        startDate,
        endDateExclusive,
        resolution,
        days: [],
      }),
      getCaloriesRange: async (startDate, endDateExclusive, resolution) => ({
        startDate,
        endDateExclusive,
        resolution,
        days: [],
      }),
    },
    journalRepository: {
      list: async () => journalEntries,
      create: async (entry) => {
        const created = { id: 'journal-1', ...entry };
        journalEntries.push(created);
        return created;
      },
      update: async (id, entry) => ({ id, ...entry }),
      remove: async (id) => ({ id, deleted: true }),
    },
    syncService: {
      enqueue: async () => ({ id: 'sync-1', status: 'queued' }),
      status: async () => ({ active: [], recent: [] }),
    },
    exportService: {
      create: async (input) => {
        const job = { id: 'export-1', status: 'queued', ...input };
        exportJobs.push(job);
        return job;
      },
      list: async () => exportJobs,
      get: async (id) => exportJobs.find((job) => job.id === id) ?? null,
      download: async () => {
        throw new Error('not used');
      },
    },
  };
}

async function withServer(options, run) {
  const server = http.createServer(createApp({ env, ...options }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: env.DASHBOARD_PASSWORD }),
  });
  return response.headers.get('set-cookie').split(';')[0];
}

test('authenticated health APIs expose dashboard and closed-open metric ranges', async () => {
  await withServer(services(), async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/dashboard?date=2026-07-16`);
    assert.equal(denied.status, 401);
    const cookie = await login(baseUrl);

    const dashboardResponse = await fetch(`${baseUrl}/api/dashboard?date=2026-07-16`, {
      headers: { cookie },
    });
    const heartResponse = await fetch(
      `${baseUrl}/api/metrics/heart?start=2026-07-10&end=2026-07-17&resolution=day`,
      { headers: { cookie } },
    );

    assert.equal(dashboardResponse.status, 200);
    assert.deepEqual(await dashboardResponse.json(), { ok: true, data: dashboard });
    assert.equal(heartResponse.status, 200);
    assert.equal((await heartResponse.json()).data.endDateExclusive, '2026-07-17');
    assert.match(dashboardResponse.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(dashboardResponse.headers.get('cache-control'), 'no-store');
  });
});

test('mutation routes enforce same-origin requests and journal CRUD remains authenticated', async () => {
  await withServer(services(), async (baseUrl) => {
    const cookie = await login(baseUrl);
    const rejected = await fetch(`${baseUrl}/api/journal`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ civilDate: '2026-07-16', body: 'context' }),
    });
    const accepted = await fetch(`${baseUrl}/api/journal`, {
      method: 'POST',
      headers: {
        cookie,
        origin: baseUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        civilDate: '2026-07-16',
        occurredAt: '2026-07-16T23:00:00.000Z',
        body: 'context',
        tags: ['rave'],
      }),
    });

    assert.equal(rejected.status, 403);
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).data.body, 'context');
  });
});

test('login throttling and database readiness are explicit', async () => {
  let time = Date.parse('2026-07-16T12:00:00Z');
  await withServer(
    {
      ...services(),
      now: () => time,
      readinessCheck: async () => true,
    },
    async (baseUrl) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'wrong' }),
        });
        assert.equal(response.status, 401);
      }
      const throttled = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      const ready = await fetch(`${baseUrl}/readyz`);

      assert.equal(throttled.status, 429);
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).ready, true);
      time += 16 * 60 * 1000;
    },
  );
});

test('export jobs are authenticated, origin-protected, and use closed-open ranges', async () => {
  await withServer(services(), async (baseUrl) => {
    const cookie = await login(baseUrl);
    const created = await fetch(`${baseUrl}/api/exports`, {
      method: 'POST',
      headers: {
        cookie,
        origin: baseUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        exportType: 'analysis',
        startDate: '2026-07-01',
        endDateExclusive: '2026-07-17',
        metrics: ['sleep', 'heart', 'calories'],
        includeJournal: false,
        includePng: true,
      }),
    });
    const listed = await fetch(`${baseUrl}/api/exports`, { headers: { cookie } });

    assert.equal(created.status, 202);
    assert.equal((await created.json()).data.endDateExclusive, '2026-07-17');
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).data.length, 1);
  });
});
