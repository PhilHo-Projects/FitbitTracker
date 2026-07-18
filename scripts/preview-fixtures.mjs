import crypto from 'node:crypto';
import path from 'node:path';

import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';
import { seedFixtures } from '../lib/db/fixtures.js';
import { createHealthRepository } from '../lib/db/health-repository.js';
import { createAnalysisDatasetService } from '../lib/exports/dataset.js';
import { createExportService } from '../lib/exports/service.js';
import { createJournalCipher } from '../lib/journal/crypto.js';
import { createJournalRepository } from '../lib/journal/repository.js';
import { createApp } from '../server.js';

const port = Number(process.env.PORT || 4173);
const anchorDate = process.env.FIXTURE_DATE || '2026-07-16';
const memory = newDb({ noAstCoverageCheck: true });
const adapter = memory.adapters.createPg();
const pool = new adapter.Pool();

await applyMigrations(pool);
await seedFixtures(pool, { anchorDate });

const keyring = `1:${crypto.createHash('sha256').update('fixture-preview-journal').digest('base64')}`;
const journalRepository = createJournalRepository(pool, createJournalCipher(keyring));
await journalRepository.create({
  civilDate: anchorDate,
  occurredAt: `${anchorDate}T23:20:00.000Z`,
  body: 'Long walk, late dinner, loud event, and more caffeine than usual.',
  tags: ['exercise', 'late meal', 'stress'],
});

const exportService = createExportService({
  pool,
  datasetService: createAnalysisDatasetService({ pool, journalRepository }),
  storageDirectory: path.resolve('.runtime', 'preview-exports'),
  rowLocks: false,
  pollIntervalMs: 250,
});
const env = {
  NODE_ENV: 'development',
  DASHBOARD_PASSWORD: '0000',
  DASHBOARD_SESSION_SECRET: 'fixture-preview-session-secret',
  JOURNAL_ENCRYPTION_KEYS: keyring,
};
const syncService = {
  async enqueue() {
    return { id: crypto.randomUUID(), status: 'queued', requestedBy: 'user' };
  },
  async status() {
    return { active: [], recent: [] };
  },
};
const app = createApp({
  env,
  pool,
  healthRepository: createHealthRepository(pool),
  journalRepository,
  syncService,
  exportService,
  readinessCheck: async () => true,
  now: () => Date.parse(`${anchorDate}T18:00:00.000Z`),
});
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Fixture preview: http://127.0.0.1:${port} (password: 0000)`);
});
exportService.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    exportService.stop();
    server.close();
    await pool.end();
    process.exit(0);
  });
}
