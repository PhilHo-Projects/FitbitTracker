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
import { createSleepCheckInRepository } from '../lib/sleep/check-ins.js';
import { seedSleepOverviewFixtures } from '../lib/db/sleep-fixtures.js';
import { createApp } from '../server.js';
import { createAuth } from '../lib/auth.js';
import { civilDateInTimeZone } from '../public/health-ui.js';

const port = Number(process.env.PORT || 4173);
const anchorDate = process.env.FIXTURE_DATE || civilDateInTimeZone(new Date(), 'America/Toronto');
const startupAt = Date.now();
console.log('Preview: preparing the in-memory database (no Docker or gateway required)...');
const memory = newDb({ noAstCoverageCheck: true });
const adapter = memory.adapters.createPg();
const pool = new adapter.Pool();

await applyMigrations(pool);
console.log('Preview: seeding synthetic sleep, heart, calorie, and SpO2 records. Wait for the ready URL before opening the browser...');
await seedFixtures(pool, { anchorDate });
await seedSleepOverviewFixtures(pool, { anchorDate });
console.log(`Preview: fixtures seeded in ${((Date.now() - startupAt) / 1000).toFixed(1)}s; creating the preview login...`);

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
  datasetService: createAnalysisDatasetService({ pool, journalRepository, sleepCheckIns: createSleepCheckInRepository(pool, createJournalCipher(keyring)) }),
  storageDirectory: path.resolve('.runtime', 'preview-exports'),
  rowLocks: false,
  pollIntervalMs: 250,
});
const env = {
  NODE_ENV: 'development',
  DASHBOARD_PASSWORD: '0000',
  DASHBOARD_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
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
await createAuth({ pool, env, allowSignUp: true }).api.signUpEmail({
  body: { email: 'preview@example.test', password: 'fixture-password-0000', name: 'Synthetic preview' },
});
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
  console.log(`Preview ready in ${((Date.now() - startupAt) / 1000).toFixed(1)}s: http://127.0.0.1:${port}`);
  console.log('Sign in: preview@example.test / fixture-password-0000 (synthetic data only). Keep this terminal running; Ctrl+C stops the preview.');
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
