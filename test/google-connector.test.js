import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoogleConnector } from '../lib/connectors/google-connector.js';

function stubRepository(initial) {
  let row = initial;
  return {
    calls: { save: 0, markDisconnected: 0 },
    async load() {
      return row;
    },
    async save(_provider, values) {
      this.calls.save += 1;
      row = {
        ...row,
        status: 'connected',
        accessToken: values.accessToken,
        refreshToken: values.refreshToken ?? row?.refreshToken,
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        lastError: null,
      };
    },
    async markDisconnected(_provider, message) {
      this.calls.markDisconnected += 1;
      row = { ...row, status: 'disconnected', lastError: message };
    },
    async markAlerted() {},
    async withLock(_provider, fn) {
      const before = row;
      try {
        return await fn(row, null);
      } catch (error) {
        row = before; // Model the repository's rollback, not just its callback.
        throw error;
      }
    },
  };
}

const FRESH = {
  provider: 'google-health',
  status: 'connected',
  accessToken: 'current',
  refreshToken: 'r1',
  accessTokenExpiresAt: new Date('2026-09-04T18:00:00Z'),
};

const STALE = { ...FRESH, accessTokenExpiresAt: new Date('2026-09-04T16:00:00Z') };
const AT = () => Date.parse('2026-09-04T17:00:00Z');

test('returns the stored access token while it is still valid', async () => {
  const repository = stubRepository(FRESH);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: { async refresh() { refreshes += 1; return {}; } },
    now: AT,
  });
  assert.equal(await connector.accessToken(), 'current');
  assert.equal(refreshes, 0);
});

test('refreshes exactly once for concurrent callers', async () => {
  const repository = stubRepository(STALE);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { accessToken: 'fresh', refreshToken: 'r2', expiresInSeconds: 3599, scope: 'a' };
      },
    },
    now: AT,
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => connector.accessToken()),
  );
  assert.deepEqual(new Set(results), new Set(['fresh']));
  assert.equal(refreshes, 1, 'concurrent callers must share one refresh');
  assert.equal(repository.calls.save, 1);
});

test('a fatal refresh marks the credential disconnected and does not retry', async () => {
  const repository = stubRepository(STALE);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        refreshes += 1;
        throw Object.assign(new Error('invalid_grant: Bad Request'), { fatal: true });
      },
    },
    now: AT,
  });
  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
  assert.equal(refreshes, 1, 'a disconnected credential must not be retried');
  assert.equal(repository.calls.markDisconnected, 1);
});

test('does not refresh a credential disconnected while waiting for the row lock', async () => {
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository: {
      async load() { return STALE; },
      async withLock(_provider, fn) {
        return fn({ ...STALE, status: 'disconnected', lastError: 'invalid_grant' }, null);
      },
    },
    oauth: {
      async refresh() {
        refreshes += 1;
        return { accessToken: 'unexpected', expiresInSeconds: 3599 };
      },
    },
    now: AT,
  });

  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
  assert.equal(refreshes, 0);
});

test('a transient refresh failure stays retryable', async () => {
  const repository = stubRepository(STALE);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        refreshes += 1;
        if (refreshes === 1) throw Object.assign(new Error('backend_error'), { fatal: false });
        return { accessToken: 'fresh', refreshToken: null, expiresInSeconds: 3599, scope: 'a' };
      },
    },
    now: AT,
  });
  await assert.rejects(connector.accessToken());
  assert.equal(await connector.accessToken(), 'fresh');
  assert.equal(repository.calls.markDisconnected, 0);
});

test('status never exposes tokens', async () => {
  const connector = createGoogleConnector({
    repository: stubRepository(FRESH),
    oauth: {},
    now: AT,
  });
  const status = await connector.status();
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes('current'));
  assert.ok(!JSON.stringify(status).includes('r1'));
});

test('a missing credential reports disconnected rather than throwing', async () => {
  const connector = createGoogleConnector({
    repository: stubRepository(null),
    oauth: {},
    now: AT,
  });
  assert.equal((await connector.status()).connected, false);
  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
});

test('onDisconnect fires once on the connected to disconnected edge', async () => {
  const repository = stubRepository(STALE);
  const fired = [];
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        throw Object.assign(new Error('invalid_grant'), { fatal: true });
      },
    },
    now: AT,
    onDisconnect: (message) => fired.push(message),
  });
  await assert.rejects(connector.accessToken());
  await assert.rejects(connector.accessToken());
  assert.equal(fired.length, 1);
});

test('disconnection commits before alerting and alert failure cannot undo it', async () => {
  const repository = stubRepository(STALE);
  let committed = false;
  const withLock = repository.withLock.bind(repository);
  repository.withLock = async (...args) => {
    const result = await withLock(...args);
    committed = true;
    return result;
  };
  let alerts = 0;
  const connector = createGoogleConnector({
    repository, now: AT,
    oauth: { async refresh() { throw Object.assign(new Error('invalid_grant'), { fatal: true }); } },
    onDisconnect: async () => {
      assert.equal(committed, true, 'alert must run after the transaction commits');
      alerts += 1;
      throw new Error('webhook unavailable');
    },
  });
  await assert.rejects(connector.accessToken(), { disconnected: true });
  assert.equal((await repository.load()).status, 'disconnected');
  await assert.rejects(connector.accessToken(), { disconnected: true });
  assert.equal(alerts, 1);
});
