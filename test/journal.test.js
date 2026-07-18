import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';
import { seedFixtures } from '../lib/db/fixtures.js';
import { createJournalCipher } from '../lib/journal/crypto.js';
import { createJournalRepository } from '../lib/journal/repository.js';

async function createFixtureDatabase() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  return pool;
}

test('journal cipher supports versioned AES-256-GCM keys', () => {
  const first = crypto.randomBytes(32).toString('base64');
  const second = crypto.randomBytes(32).toString('base64');
  const cipher = createJournalCipher(`1:${first},2:${second}`);

  const encrypted = cipher.encrypt('Took 8 grams of mushrooms and went to a rave.');

  assert.equal(encrypted.keyVersion, 2);
  assert.notEqual(encrypted.ciphertext.toString('utf8'), 'Took 8 grams of mushrooms and went to a rave.');
  assert.equal(cipher.decrypt(encrypted), 'Took 8 grams of mushrooms and went to a rave.');
});

test('journal repository encrypts bodies, normalizes tags, and preserves revisions', async () => {
  const pool = await createFixtureDatabase();
  const key = crypto.randomBytes(32).toString('base64');
  const repository = createJournalRepository(pool, createJournalCipher(`1:${key}`));

  const created = await repository.create({
    civilDate: '2026-07-16',
    occurredAt: '2026-07-16T23:30:00.000Z',
    body: 'Late meal after a long rave.',
    tags: ['Late Meal', 'substance', 'late meal'],
  });
  const raw = (await pool.query('SELECT ciphertext FROM journal_entries WHERE id = $1', [created.id])).rows[0];

  assert.equal(created.body, 'Late meal after a long rave.');
  assert.deepEqual(created.tags, ['Late Meal', 'substance']);
  assert.equal(raw.ciphertext.includes('Late meal after a long rave.'), false);

  const updated = await repository.update(created.id, {
    body: 'Late meal after a long rave; hydration was low.',
    tags: ['late meal', 'hydration'],
  });
  const revisions = await pool.query(
    'SELECT revision_number FROM journal_entry_revisions WHERE journal_entry_id = $1',
    [created.id],
  );

  assert.equal(updated.body, 'Late meal after a long rave; hydration was low.');
  assert.deepEqual(updated.tags, ['hydration', 'late meal']);
  assert.equal(revisions.rowCount, 1);
  assert.equal(revisions.rows[0].revision_number, 1);

  const entries = await repository.list({
    startDate: '2026-07-16',
    endDateExclusive: '2026-07-17',
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].body, updated.body);

  await repository.remove(created.id);
  assert.deepEqual(
    await repository.list({ startDate: '2026-07-16', endDateExclusive: '2026-07-17' }),
    [],
  );

  await pool.end();
});
