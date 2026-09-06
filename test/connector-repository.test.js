import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { createKeyringCipher } from '../lib/crypto/keyring.js';
import { applyMigrations } from '../lib/db/migrations.js';
import { createConnectorRepository } from '../lib/connectors/repository.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

async function createRepository() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  const cipher = createKeyringCipher({
    serializedKeyring: `1:${KEY}`,
    label: 'connector',
    subject: 'Connector',
    variableName: 'CONNECTOR_ENCRYPTION_KEYS',
  });
  return { pool, repository: createConnectorRepository(pool, cipher) };
}

test('returns null before anything is stored', async () => {
  const { repository } = await createRepository();
  assert.equal(await repository.load('google-health'), null);
});

test('round trips tokens and reports connected', async () => {
  const { repository } = await createRepository();
  const expiresAt = new Date('2026-09-04T17:00:00Z');
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a b',
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    accessTokenExpiresAt: expiresAt,
  });
  const stored = await repository.load('google-health');
  assert.equal(stored.status, 'connected');
  assert.equal(stored.accessToken, 'access-value');
  assert.equal(stored.refreshToken, 'refresh-value');
  assert.equal(stored.googleAccountEmail, 'owner@example.com');
  assert.equal(new Date(stored.accessTokenExpiresAt).toISOString(), expiresAt.toISOString());
});

test('never stores a token in plaintext', async () => {
  const { pool, repository } = await createRepository();
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    accessTokenExpiresAt: new Date(),
  });
  const raw = JSON.stringify(
    (await pool.query('SELECT * FROM connector_credentials')).rows,
  );
  assert.ok(!raw.includes('access-value'));
  assert.ok(!raw.includes('refresh-value'));
});

test('marking disconnected keeps the refresh token but changes status', async () => {
  const { repository } = await createRepository();
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    accessTokenExpiresAt: new Date(),
  });
  await repository.markDisconnected('google-health', 'invalid_grant');
  const stored = await repository.load('google-health');
  assert.equal(stored.status, 'disconnected');
  assert.equal(stored.lastError, 'invalid_grant');
  assert.ok(stored.disconnectedAt);
});

test('reconnecting clears the previous error and alert', async () => {
  const { repository } = await createRepository();
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'a1',
    refreshToken: 'r1',
    accessTokenExpiresAt: new Date(),
  });
  await repository.markDisconnected('google-health', 'invalid_grant');
  await repository.markAlerted('google-health', new Date());
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'a2',
    refreshToken: 'r2',
    accessTokenExpiresAt: new Date(),
  });
  const stored = await repository.load('google-health');
  assert.equal(stored.status, 'connected');
  assert.equal(stored.lastError, null);
  assert.equal(stored.alertedAt, null);
});

test('preserves a refresh token across encryption-key rotation', async () => {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  const oldCipher = createKeyringCipher({
    serializedKeyring: `1:${KEY}`,
    label: 'connector',
    subject: 'Connector',
    variableName: 'CONNECTOR_ENCRYPTION_KEYS',
  });
  await createConnectorRepository(pool, oldCipher).save('google-health', {
    accessToken: 'a1',
    refreshToken: 'r1',
    accessTokenExpiresAt: new Date(),
  });

  const newKey = Buffer.alloc(32, 8).toString('base64');
  const rotatedCipher = createKeyringCipher({
    serializedKeyring: `1:${KEY},2:${newKey}`,
    label: 'connector',
    subject: 'Connector',
    variableName: 'CONNECTOR_ENCRYPTION_KEYS',
  });
  const repository = createConnectorRepository(pool, rotatedCipher);
  await repository.save('google-health', {
    accessToken: 'a2',
    refreshToken: null,
    accessTokenExpiresAt: new Date(),
  });

  const stored = await repository.load('google-health');
  assert.equal(stored.accessToken, 'a2');
  assert.equal(stored.refreshToken, 'r1');
});
