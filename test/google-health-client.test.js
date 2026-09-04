import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoogleHealthClient } from '../lib/jobs/google-health-client.js';
import { buildGoogleHealthRequest } from '../lib/jobs/google-health-request.js';

const connector = { async accessToken() { return 'token-value'; } };

test('builds a list url with a civil-time filter', () => {
  const built = buildGoogleHealthRequest({
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-09-01',
    endDateExclusive: '2026-09-02',
  });
  const url = new URL(built.url);
  assert.equal(url.origin, 'https://health.googleapis.com');
  assert.equal(url.pathname, '/v4/users/me/dataTypes/heart-rate/dataPoints');
  assert.equal(
    url.searchParams.get('filter'),
    'heart_rate.sample_time.civil_time >= "2026-09-01" AND heart_rate.sample_time.civil_time < "2026-09-02"',
  );
  assert.equal(built.method, 'GET');
});

test('sleep reconcile targets the wearables data source family', () => {
  const url = new URL(
    buildGoogleHealthRequest({
      operation: 'reconcile',
      metric: 'sleep',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    }).url,
  );
  assert.equal(url.pathname, '/v4/users/me/dataTypes/sleep/dataPoints:reconcile');
  assert.equal(
    url.searchParams.get('dataSourceFamily'),
    'users/me/dataSourceFamilies/google-wearables',
  );
  assert.equal(url.searchParams.get('pageSize'), '25');
});

test('total-calories rollup posts a range body', () => {
  const built = buildGoogleHealthRequest({
    operation: 'rollUp',
    metric: 'total-calories',
    startDate: '2026-09-01',
    endDateExclusive: '2026-09-02',
    timezone: 'America/Toronto',
  });
  assert.equal(built.method, 'POST');
  assert.match(built.url, /dataPoints:rollUp$/);
  assert.equal(built.body.windowSize, '3600s');
  assert.ok(built.body.range.startTime);
});

test('rejects an unsupported operation and metric pair', () => {
  assert.throws(
    () => buildGoogleHealthRequest({ operation: 'rollUp', metric: 'sleep' }),
    /Unsupported gateway request/,
  );
});

test('sends the bearer token and unwraps the response', async () => {
  let seen = null;
  const client = createGoogleHealthClient({
    connector,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ dataPoints: [{ a: 1 }], nextPageToken: 'next' }),
      };
    },
  });
  const result = await client.request({
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-09-01',
    endDateExclusive: '2026-09-02',
  });
  assert.equal(seen.options.headers.authorization, 'Bearer token-value');
  assert.equal(result.ok, true);
  assert.equal(result.metric, 'heart-rate');
  assert.equal(result.nextPageToken, 'next');
  assert.deepEqual(result.data.dataPoints, [{ a: 1 }]);
});

test('marks 5xx and 429 transient and 4xx permanent', async () => {
  const build = (status) =>
    createGoogleHealthClient({
      connector,
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({ error: { message: 'nope' } }),
      }),
    }).request({
      operation: 'list',
      metric: 'heart-rate',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    });

  await assert.rejects(build(503), (error) => error.transient === true);
  await assert.rejects(build(429), (error) => error.transient === true);
  await assert.rejects(build(400), (error) => error.transient === false);
});

test('a disconnected connector surfaces as a permanent failure', async () => {
  const client = createGoogleHealthClient({
    connector: {
      async accessToken() {
        throw Object.assign(new Error('invalid_grant'), { disconnected: true, transient: false });
      },
    },
    fetchImpl: async () => {
      throw new Error('fetch must not be called when disconnected');
    },
  });
  await assert.rejects(
    client.request({
      operation: 'list',
      metric: 'heart-rate',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    }),
    (error) => error.transient === false,
  );
});
