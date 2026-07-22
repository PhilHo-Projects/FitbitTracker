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
    assert.equal(manifest.rawCoverage, null);

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
    const archiveManifest = JSON.parse(archive.readAsText('manifest.json'));
    assert.equal(archiveManifest.rawCoverage.exactLocal.heart.rowCount, 96);
    assert.equal(archiveManifest.rawCoverage.exactLocal.calories.rowCount, 96);
    assert.deepEqual(archiveManifest.rawCoverage.coldArchiveMonths, []);
    assert.deepEqual(archiveManifest.rawCoverage.summaryOnlyMonths, []);
    assert.deepEqual(archiveManifest.rawCoverage.summaryOnlyCoverage, []);

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

test('raw export iterators use stable keyset cursors and never OFFSET paging', async () => {
  const calls = [];
  const rows = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      provider_key: 'heart:1',
      provider_id: null,
      civil_date: '2026-01-01',
      sampled_at_text: '2026-01-01T00:00:00.000123Z',
      utc_offset_seconds: 0,
      beats_per_minute: 60,
      device: {},
      source_fields: {},
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      provider_key: 'heart:2',
      provider_id: null,
      civil_date: '2026-01-01',
      sampled_at_text: '2026-01-01T00:00:00.000456Z',
      utc_offset_seconds: 0,
      beats_per_minute: 61,
      device: {},
      source_fields: {},
    },
    {
      id: '10000000-0000-4000-8000-000000000003',
      provider_key: 'heart:3',
      provider_id: null,
      civil_date: '2026-01-01',
      sampled_at_text: '2026-01-01T00:00:00.000789Z',
      utc_offset_seconds: 0,
      beats_per_minute: 62,
      device: {},
      source_fields: {},
    },
  ];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM source_accounts/.test(sql)) {
        return {
          rows: [{
            id: 'account-1',
            provider: 'google-health-connect',
            provider_account_id: 'fixture',
            display_name: 'Fixture',
            timezone: 'UTC',
            membership_start_date: '2026-01-01',
          }],
        };
      }
      if (/FROM heart_rate_samples/.test(sql)) {
        const cursor = params[3] ?? null;
        const available = rows.filter((row) => cursor === null || row.id > cursor);
        return { rows: available.slice(0, Number(params.at(-1))) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const dataset = createAnalysisDatasetService({ pool, batchSize: 2 });
  const streamed = [];
  for await (const row of await dataset.streamHeartRateSamples({
    startDate: '2026-01-01',
    endDateExclusive: '2026-01-02',
  })) streamed.push(row);

  assert.deepEqual(streamed.map(({ sampledAt }) => sampledAt), [
    '2026-01-01T00:00:00.000123Z',
    '2026-01-01T00:00:00.000456Z',
    '2026-01-01T00:00:00.000789Z',
  ]);
  assert.equal(calls.some(({ sql }) => /\bOFFSET\b/i.test(sql)), false);
  assert.equal(calls.filter(({ sql }) => /FROM heart_rate_samples/.test(sql)).length, 2);
});

test('full export coverage distinguishes cold archive months from summary-only months', async () => {
  const fixture = await fixtureServices();
  try {
    const sourceAccountId = (
      await fixture.pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
    ).rows[0].id;
    await fixture.pool.query(
      `INSERT INTO health_archive_catalog (
         id, source_account_id, archive_month, archive_version, is_active, state,
         heart_sample_count, calorie_interval_count, verified_at
       ) VALUES ($1, $2, '2026-01-01', 1, true, 'verified', 100, 200, $3)`,
      ['94000000-0000-4000-8000-000000000001', sourceAccountId, '2026-04-25T03:00:00Z'],
    );
    const coverage = await fixture.datasetService.rawCoverage(
      { startDate: '2026-01-01', endDateExclusive: '2026-03-01' },
      ['heart', 'calories'],
    );

    assert.equal(coverage.exactLocal.heart.rowCount, 0);
    assert.equal(coverage.exactLocal.calories.rowCount, 0);
    assert.deepEqual(coverage.coldArchiveMonths.map(({ month }) => month), ['2026-01-01']);
    assert.deepEqual(coverage.summaryOnlyMonths, ['2026-02-01']);
    assert.deepEqual(coverage.summaryOnlyCoverage, [
      { month: '2026-02-01', metrics: ['heart', 'calories'] },
    ]);
  } finally {
    await fixture.pool.end();
  }
});
