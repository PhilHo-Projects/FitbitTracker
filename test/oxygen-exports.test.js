import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createOxygenDatabase, oxygenAccountId as account, oxygenPoint, oxygenDailyPoint } from '../test-support/oxygen.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { normalizeOxygenSaturationSamples as samples, normalizeDailyOxygenSaturation as daily } from '../lib/metrics/oxygen-normalizer.js';
import { createAnalysisDatasetService } from '../lib/exports/dataset.js';
import { createExportService } from '../lib/exports/service.js';
import { buildSummarySvg } from '../lib/exports/png.js';

test('oxygen-only exports retain every source, precision and dates missing other health metrics', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const writer = createMetricWriter(pool);
  await writer.upsertDailyOxygenSaturation(account, daily({ dataPoints: [oxygenDailyPoint({ lower: 94 }), oxygenDailyPoint({ id: 'other', dataSource: {} })] }));
  await writer.upsertOxygenSaturationSamples(account, samples({ dataPoints: [
    oxygenPoint({ id: 'evening', time: '2026-09-07T03:59:59.999999999Z', percentage: 92.123456789 }),
    oxygenPoint({ id: 'zero', time: '2026-09-07T05:00:00Z', percentage: 0 }),
    oxygenPoint({ id: 'other-source', time: '2026-09-07T05:00:00Z', percentage: 98, dataSource: {} }),
  ] }));
  const datasetService = createAnalysisDatasetService({ pool, batchSize: 1, journalRepository: { list: () => assert.fail('journal requires opt-in') } });
  const range = { startDate: '2026-09-06', endDateExclusive: '2026-09-08' };
  const analysis = await datasetService.buildAnalysisDataset(range, ['oxygen']);
  assert.equal(analysis.schemaVersion, '1.1.0');
  assert.equal(analysis.oxygenDailySummaries.length, 2);
  assert.equal(analysis.oxygenSaturationSamples.length, 0);
  assert.deepEqual(analysis.dailySummaries.map(row => row.date), ['2026-09-06', '2026-09-07']);
  assert.equal(analysis.dailySummaries[1].oxygenAveragePercentage, null);
  assert.equal(analysis.dailySummaries[1].oxygenSummaryState, 'ambiguous');
  const stream = await datasetService.streamOxygenSaturationSamples(range);
  const raw = []; for await (const row of stream) raw.push(row);
  assert.equal(raw.length, 3);
  assert.ok(raw.some(row => row.sampledAt.endsWith('.999999999Z') && row.percentage === 92.123456789));
  assert.ok(raw.some(row => row.percentage === 0));
  const oneDay = []; for await (const row of await datasetService.streamOxygenSaturationSamples({ startDate: '2026-09-07', endDateExclusive: '2026-09-08' })) oneDay.push(row);
  assert.equal(oneDay.length, 2);
  const storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'oxygen-export-'));
  const exports = createExportService({ pool, datasetService, storageDirectory, rowLocks: false });
  const job = await exports.create({ ...range, metrics: ['oxygen'], exportType: 'archive', includeJournal: false, includePng: true });
  await exports.runOnce();
  const completed = await exports.get(job.id);
  assert.equal(completed.status, 'completed', completed.errorMessage);
  const zip = new AdmZip(await readFile(completed.filePath));
  const manifest = JSON.parse(zip.readAsText('manifest.json'));
  assert.equal(manifest.schemaVersion, '1.1.0');
  assert.equal(manifest.units.oxygenSaturation, 'percent');
  assert.equal(manifest.rawCoverage.oxygen.coldArchiveSupported, false);
  assert.equal(manifest.rawCoverage.oxygen.sampleCount, 3);
  assert.match(zip.readAsText('oxygen-saturation-daily.csv'), /lower_bound_percentage/);
  assert.doesNotMatch(zip.readAsText('oxygen-saturation-daily.csv'), /minimum_percentage/);
  assert.match(zip.readAsText('oxygen-saturation-samples.csv'), /03:59:59.999999999Z/);
  assert.ok(zip.getEntry('summary.png'));
  assert.ok(!zip.getEntry('journal.md'));
});

test('oxygen PNG keeps decimal percentages and zero without rounding them to missing', () => {
  const svg = buildSummarySvg({ schemaVersion: '1.1.0', range: { startDate: '2026-09-07', endDateExclusive: '2026-09-08' }, timezone: 'America/Toronto',
    metrics: ['oxygen'], dailySummaries: [{ date: '2026-09-07', oxygenAveragePercentage: 0 }], sleepStages: [], coverageWarnings: [] });
  assert.match(svg, /0\.0%/); assert.match(svg, /Blood oxygen/); assert.match(svg, /1 days measured/);
});
