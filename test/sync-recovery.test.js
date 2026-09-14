import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncService } from '../lib/jobs/sync-service.js';
import { createSyncRepository } from '../lib/jobs/sync-repository.js';
import { createOxygenDatabase, oxygenAccountId } from '../test-support/oxygen.js';
import { createKeyringCipher } from '../lib/crypto/keyring.js';
import { createConnectorRepository } from '../lib/connectors/repository.js';
import { createGoogleConnector } from '../lib/connectors/google-connector.js';

test('new consent persists recovery intent, refresh preserves it, and generation guards acknowledgement', async () => {
  const pool = await createOxygenDatabase();
  const cipher = createKeyringCipher({ serializedKeyring: `1:${Buffer.alloc(32, 2).toString('base64')}` });
  const repository = createConnectorRepository(pool, cipher);
  const connector = createGoogleConnector({ repository, oauth: { exchangeCode: async () => ({ accessToken: 'fixture', refreshToken: 'fixture-refresh', expiresInSeconds: 3600 }) } });
  await connector.connectWithCode('fixture-code');
  const initial = await connector.status();
  assert.equal(initial.recoveryPending, true);
  assert.match(initial.connectionGeneration, /^[a-f0-9-]{36}$/);
  await repository.save('google-health', { accessToken: 'refreshed', accessTokenExpiresAt: new Date() });
  assert.equal((await connector.status()).connectionGeneration, initial.connectionGeneration);
  await connector.recoveryScheduled('cc34a9de-aea2-405a-acb9-886fc3b6b181');
  assert.equal((await connector.status()).recoveryPending, true);
  await connector.recoveryScheduled(initial.connectionGeneration);
  assert.equal((await connector.status()).recoveryPending, false);
  await repository.markDisconnected('google-health', 'Google OAuth: invalid_grant');
  const disconnected = await connector.status();
  await connector.connectWithCode('second-consent');
  const next = await connector.status();
  assert.notEqual(next.connectionGeneration, initial.connectionGeneration);
  assert.equal(new Date(next.recoveryFrom).toISOString(), new Date(disconnected.disconnectedAt).toISOString());
  await pool.end();
});

test('disconnected sync retains queued work, skips scheduling and gives manual callers a reconnect action', async () => {
  const pool = await createOxygenDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const service = createSyncService({ pool, repository, gateway: {}, writer: {},
    connector: { status: async () => ({ connected: false }) },
    now: () => Date.parse('2026-09-13T20:00:00Z') });
  await repository.enqueue({ sourceAccountId: oxygenAccountId, jobType: 'incremental', metrics: ['sleep'],
    startDate: '2026-09-12', endDateExclusive: '2026-09-14', requestedBy: 'test',
    chunks: [{ metric: 'sleep', operation: 'reconcile', startDate: '2026-09-12', endDateExclusive: '2026-09-14' }] });
  await assert.rejects(service.enqueue(), { status: 409, code: 'GOOGLE_RECONNECT_REQUIRED' });
  assert.equal(await service.enqueue({ requestedBy: 'schedule' }), null);
  assert.equal(await service.runOnce(), false);
  assert.equal((await pool.query('SELECT status FROM sync_chunks')).rows[0].status, 'queued');
  assert.equal((await service.status()).pausedReason, 'GOOGLE_RECONNECT_REQUIRED');
  await pool.end();
});

test('reconnect recovery deduplicates durably and covers the disconnection gap within raw retention', async () => {
  const pool = await createOxygenDatabase();
  const state = { connected: true, connectionGeneration: 'b29330b7-f3a9-4c6f-a2d1-d88016576293',
    recoveryPending: true, recoveryFrom: '2026-05-01T19:00:00Z' };
  const connector = { status: async () => state, recoveryScheduled: async () => {} };
  const make = () => createSyncService({ pool, repository: createSyncRepository(pool, { advisoryLocks: false }),
    gateway: {}, writer: {}, connector, rawRetentionDays: 90, now: () => Date.parse('2026-09-13T20:00:00Z') });
  const first = await make().recoverConnection();
  const second = await make().recoverConnection();
  assert.equal(first.id, second.id);
  assert.equal((await pool.query('SELECT count(*) AS n FROM sync_jobs')).rows[0].n, 1);
  const rows = (await pool.query('SELECT metric,start_date,end_date_exclusive FROM sync_chunks')).rows;
  assert.ok(rows.some(x => x.metric === 'sleep'));
  assert.ok(rows.every(x => !x.metric.includes('calories') && !x.metric.includes('energy-burned')));
  assert.ok(rows.some(x => x.metric === 'oxygen-saturation'));
  assert.ok(rows.filter(x => x.metric === 'oxygen-saturation').every(x => new Date(x.start_date) >= new Date('2026-06-16')));
  assert.ok(rows.some(x => x.metric === 'sleep' && new Date(x.start_date).toISOString().slice(0, 10) === '2026-05-01'));
  await pool.end();
});

test('recovery enqueue failures retain the intent and allow pending work, with bounded retries', async () => {
  const pool = await createOxygenDatabase();
  let attempts = 0, claims = 0, time = Date.parse('2026-09-13T20:00:00Z');
  const service = createSyncService({ pool, gateway: {}, writer: {}, now: () => time,
    repository: { enqueue: async () => { attempts++; throw new Error('private database detail'); }, claimNextChunk: async () => { claims++; return null; } },
    connector: { status: async () => ({ connected: true, recoveryPending: true, connectionGeneration: 'fixture' }) } });
  await service.runOnce(); await service.runOnce();
  assert.equal(attempts, 1); assert.equal(claims, 2);
  time += 60_000;
  await service.runOnce();
  assert.equal(attempts, 2);
  await pool.end();
});

test('safe sync errors distinguish auth, contract, transport and storage without upstream payloads', async () => {
  const { classifySyncError } = await import('../lib/jobs/sync-errors.js');
  for (const [error, phase, code] of [
    [Object.assign(new Error('secret'), { disconnected: true, status: 401 }), 'fetch', 'GOOGLE_RECONNECT_REQUIRED'],
    [Object.assign(new Error('secret'), { status: 403 }), 'fetch', 'UPSTREAM_PERMISSION_DENIED'],
    [Object.assign(new Error('secret'), { status: 429 }), 'fetch', 'UPSTREAM_RATE_LIMITED'],
    [Object.assign(new Error('secret'), { status: 503 }), 'fetch', 'UPSTREAM_UNAVAILABLE'],
    [Object.assign(new Error('secret'), { code: 'OXYGEN_CONTRACT_INVALID' }), 'ingest', 'PROVIDER_CONTRACT_INVALID'],
    [Object.assign(new Error('secret'), { code: '23505' }), 'ingest', 'STORAGE_ERROR'],
  ]) {
    const safe = classifySyncError(error, phase);
    assert.equal(safe.code, code);
    assert.ok(!safe.message.includes('secret'));
  }
});
