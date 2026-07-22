import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCatalogEnvelopeBinding } from '../lib/archive/service.js';

const catalog = {
  source_account_id: '11111111-1111-1111-1111-111111111111',
  archive_month: '2026-01-01',
  encryption_key_version: 2,
};

test('operator recovery binds authenticated envelope source, month, and key version to catalog', () => {
  assert.doesNotThrow(() => assertCatalogEnvelopeBinding(catalog, {
    sourceAccountId: catalog.source_account_id,
    archiveMonth: catalog.archive_month,
    encryptionKeyVersion: 2,
  }));
  for (const header of [
    { sourceAccountId: '99999999-9999-9999-9999-999999999999', archiveMonth: '2026-01-01', encryptionKeyVersion: 2 },
    { sourceAccountId: catalog.source_account_id, archiveMonth: '2026-02-01', encryptionKeyVersion: 2 },
    { sourceAccountId: catalog.source_account_id, archiveMonth: '2026-01-01', encryptionKeyVersion: 1 },
  ]) {
    assert.throws(() => assertCatalogEnvelopeBinding(catalog, header), /authenticated metadata mismatch/);
  }
});
