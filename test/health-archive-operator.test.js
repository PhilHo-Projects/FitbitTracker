import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseHealthArchiveArgs } from '../lib/archive/operator.js';

test('health archive operator exposes safe list, verify, extract, import, and run commands', async () => {
  assert.deepEqual(parseHealthArchiveArgs(['list']), { command: 'list' });
  assert.deepEqual(parseHealthArchiveArgs(['verify', '--id', 'catalog-id']), {
    command: 'verify', id: 'catalog-id',
  });
  assert.deepEqual(parseHealthArchiveArgs(['extract', '--id=catalog-id', '--output', './restore']), {
    command: 'extract', id: 'catalog-id', outputDirectory: './restore',
  });
  assert.deepEqual(parseHealthArchiveArgs([
    'import', '--id', 'catalog-id', '--target-database-url', 'postgres://localhost/restore_test',
    '--allow-production-target', '--batch-size=25',
  ]), {
    command: 'import',
    id: 'catalog-id',
    targetDatabaseUrl: 'postgres://localhost/restore_test',
    allowProductionTarget: true,
    batchSize: 25,
  });
  assert.deepEqual(parseHealthArchiveArgs([
    'run', '--source-account', 'account-id', '--month', '2026-01-01',
  ]), {
    command: 'run',
    sourceAccountId: 'account-id',
    archiveMonth: '2026-01-01',
    execute: false,
    prune: false,
  });
  assert.deepEqual(parseHealthArchiveArgs([
    'run', '--source-account=account-id', '--month=2026-01-01', '--execute', '--prune',
  ]), {
    command: 'run',
    sourceAccountId: 'account-id',
    archiveMonth: '2026-01-01',
    execute: true,
    prune: true,
  });
  assert.throws(() => parseHealthArchiveArgs(['run', '--prune']), /--prune requires --execute/);
  assert.throws(() => parseHealthArchiveArgs(['import', '--id', 'catalog-id']), /--target-database-url/);

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['health:archive'], 'node scripts/health-archive.mjs');
});
