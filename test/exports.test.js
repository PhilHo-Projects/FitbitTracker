import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import AdmZip from 'adm-zip';
import { newDb } from 'pg-mem';

import { applyMigrations } from '../lib/db/migrations.js';
import { seedFixtures } from '../lib/db/fixtures.js';
import { createAnalysisDatasetService } from '../lib/exports/dataset.js';
import { createExportService } from '../lib/exports/service.js';
import { createJournalCipher } from '../lib/journal/crypto.js';
import { createJournalRepository } from '../lib/journal/repository.js';

const KEYRING = `1:${Buffer.alloc(32, 7).toString('base64')}`;

async function fixtureServices() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  await seedFixtures(pool, { anchorDate: '2026-07-16' });
  const journalRepository = createJournalRepository(pool, createJournalCipher(KEYRING));
  await journalRepository.create({
    civilDate: '2026-07-16',
    occurredAt: '2026-07-16T23:00:00.000Z',
    body: 'Late rave, intense dancing, and a late meal.',
    tags: ['exercise', 'late meal'],
  });
  return {
    pool,
    journalRepository,
    datasetService: createAnalysisDatasetService({ pool, journalRepository }),
  };
}

test('analysis datasets keep exact summaries primary and include raw records only at full detail', async () => {
  const fixture = await fixtureServices();
  try {
    await fixture.pool.query(
      `UPDATE daily_health_summaries
       SET coverage = $1
       WHERE civil_date = '2026-07-16'`,
      [{ sleep: 'complete', heart: 'partial', calories: 'complete' }],
    );
    const range = { startDate: '2026-07-15', endDateExclusive: '2026-07-17' };
    const analysis = await fixture.datasetService.buildAnalysisDataset(
      range,
      ['sleep', 'heart', 'calories'],
      'analysis',
      true,
    );
    const archive = await fixture.datasetService.buildAnalysisDataset(
      range,
      ['sleep', 'heart', 'calories'],
      'full',
      false,
    );

    assert.equal(analysis.schemaVersion, '1.0.0');
    assert.equal(analysis.timezone, 'America/Toronto');
    assert.equal(analysis.dailySummaries.length, 2);
    assert.equal(analysis.sleepSessions.length, 2);
    assert.equal(analysis.sleepStages.length, 24);
    assert.equal(analysis.heartRateSamples.length, 0);
    assert.equal(analysis.calorieIntervals.length, 0);
    assert.equal(analysis.journal.length, 1);
    assert.equal(analysis.journal[0].body, 'Late rave, intense dancing, and a late meal.');
    assert.deepEqual(analysis.coverageWarnings, [
      {
        date: '2026-07-16',
        metrics: ['heart'],
        message: 'One or more requested metrics have partial or missing coverage.',
      },
    ]);

    assert.equal(archive.heartRateSamples.length, 96);
    assert.equal(archive.calorieIntervals.length, 96);
    assert.deepEqual(archive.journal, []);
    assert.deepEqual(archive.metrics, ['sleep', 'heart', 'calories']);
  } finally {
    await fixture.pool.end();
  }
});

test('background export jobs create inspectable ZIP and PNG artifacts and expire them after 24 hours', async () => {
  const fixture = await fixtureServices();
  const storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'health-export-'));
  let clock = Date.parse('2026-07-16T18:00:00.000Z');
  const service = createExportService({
    pool: fixture.pool,
    datasetService: fixture.datasetService,
    storageDirectory,
    now: () => clock,
    rowLocks: false,
  });

  try {
    const staleJob = await service.create({
      exportType: 'analysis',
      startDate: '2026-07-16',
      endDateExclusive: '2026-07-17',
      metrics: ['sleep', 'heart', 'calories'],
      detailLevel: 'analysis',
      includeJournal: false,
      includePng: false,
    });
    await fixture.pool.query(
      `UPDATE export_jobs SET status = 'running', started_at = $1 WHERE id = $2`,
      [new Date(clock), staleJob.id],
    );
    clock += 16 * 60 * 1000;
    const recovered = await service.recoverStaleJobs();
    assert.equal(recovered.jobs, 1);
    assert.equal((await service.get(staleJob.id)).status, 'queued');
    await service.runOnce();
    assert.equal((await service.get(staleJob.id)).status, 'completed');

    const zipJob = await service.create({
      exportType: 'analysis',
      startDate: '2026-07-15',
      endDateExclusive: '2026-07-17',
      metrics: ['sleep', 'heart', 'calories'],
      detailLevel: 'analysis',
      includeJournal: true,
      includePng: true,
    });
    assert.equal(zipJob.status, 'queued');
    await service.runOnce();

    const completedZip = await service.get(zipJob.id);
    assert.equal(completedZip.status, 'completed');
    assert.match(completedZip.fileName, /\.zip$/);
    assert.ok((await stat(completedZip.filePath)).size > 1_000);

    const zip = new AdmZip(completedZip.filePath);
    const names = zip.getEntries().map(({ entryName }) => entryName).sort();
    assert.deepEqual(names, [
      'daily-summary.csv',
      'journal.md',
      'manifest.json',
      'sleep-sessions.csv',
      'sleep-stages.csv',
      'summary.png',
    ]);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    assert.equal(manifest.schemaVersion, '1.0.0');
    assert.equal(manifest.range.endDateExclusive, '2026-07-17');
    assert.equal(manifest.journalIncluded, true);
    assert.equal(manifest.files.length, 6);

    const archiveJob = await service.create({
      exportType: 'archive',
      startDate: '2026-07-15',
      endDateExclusive: '2026-07-17',
      metrics: ['sleep', 'heart', 'calories'],
      detailLevel: 'full',
      includeJournal: false,
      includePng: false,
    });
    await service.runOnce();
    const completedArchive = await service.get(archiveJob.id);
    const archive = new AdmZip(completedArchive.filePath);
    assert.equal(completedArchive.status, 'completed');
    assert.ok(archive.getEntry('heart-rate-samples.csv').getData().toString().split('\n').length > 90);
    assert.ok(archive.getEntry('calorie-intervals.csv').getData().toString().split('\n').length > 90);

    const pngJob = await service.create({
      exportType: 'png',
      startDate: '2026-07-16',
      endDateExclusive: '2026-07-17',
      metrics: ['sleep', 'heart', 'calories'],
      detailLevel: 'analysis',
      includeJournal: false,
      includePng: true,
    });
    await service.runOnce();
    const completedPng = await service.get(pngJob.id);
    assert.equal(completedPng.status, 'completed');
    assert.deepEqual(
      (await readFile(completedPng.filePath)).subarray(0, 8),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    clock += 25 * 60 * 60 * 1_000;
    const cleanup = await service.cleanupExpired();
    assert.equal(cleanup.removed, 4);
    assert.equal((await service.get(zipJob.id)).status, 'expired');
    await assert.rejects(stat(completedZip.filePath), { code: 'ENOENT' });
  } finally {
    await fixture.pool.end();
  }
});
