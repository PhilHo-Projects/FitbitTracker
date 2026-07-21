import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ARCHIVE_FILE_NAMES,
  buildMonthBundle,
  extractMonthBundle,
  validateExtractedMonth,
} from '../lib/archive/bundle.js';

const sourceAccountId = '11111111-1111-1111-1111-111111111111';
const sourceStreamId = '22222222-2222-2222-2222-222222222222';

function archivePool() {
  const queries = [];
  const streams = [{
    id: sourceStreamId,
    metadata: { device: { model: 'Watch', manufacturer: 'Fixture' }, dataType: 'heart-rate' },
    metadata_hash: 'a'.repeat(64),
  }];
  const hearts = [
    {
      source_stream_id: sourceStreamId,
      civil_date: '2026-01-02',
      sampled_at: '2026-01-02T12:00:00.000Z',
      utc_offset_seconds: -18000,
      beats_per_minute: '70.00',
      upstream_sample_id: 'heart,one',
    },
    {
      source_stream_id: sourceStreamId,
      civil_date: '2026-01-02',
      sampled_at: '2026-01-02T12:05:00.000Z',
      utc_offset_seconds: -18000,
      beats_per_minute: '71.50',
      upstream_sample_id: null,
    },
  ];
  const calories = [{
    source_stream_id: sourceStreamId,
    civil_date: '2026-01-02',
    interval_type: 'active',
    start_at: '2026-01-02T12:00:00.000Z',
    end_at: '2026-01-02T12:05:00.000Z',
    utc_offset_seconds: -18000,
    kilocalories: '0.0000',
    upstream_sample_id: 'calorie-one',
  }];

  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      const limit = params.at(-1);
      if (sql.includes('FROM source_streams')) {
        const cursor = params[2];
        return { rows: streams.filter((row) => !cursor || row.id > cursor).slice(0, limit) };
      }
      if (sql.includes('FROM heart_rate_samples_compact')) {
        const cursorTime = params[2];
        const cursorStream = params[3];
        return {
          rows: hearts.filter((row) => !cursorTime
            || row.sampled_at > cursorTime
            || (row.sampled_at === cursorTime && row.source_stream_id > cursorStream)).slice(0, limit),
        };
      }
      if (sql.includes('FROM calorie_intervals_compact')) {
        const [cursorStart, cursorType, cursorStream] = params.slice(2, 5);
        return {
          rows: calories.filter((row) => !cursorStart
            || [row.start_at, row.interval_type, row.source_stream_id].join(':')
              > [cursorStart, cursorType, cursorStream].join(':')).slice(0, limit),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('monthly bundle has deterministic schemas and bytes with bounded keyset exports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'health-bundle-'));
  const firstFiles = path.join(root, 'first-files');
  const secondFiles = path.join(root, 'second-files');
  const extracted = path.join(root, 'extracted');
  const firstBundle = path.join(root, 'first.gz');
  const secondBundle = path.join(root, 'second.gz');
  const firstPool = archivePool();
  const secondPool = archivePool();

  try {
    const first = await buildMonthBundle({
      pool: firstPool,
      sourceAccountId,
      archiveMonth: '2026-01-01',
      directory: firstFiles,
      outputPath: firstBundle,
      batchSize: 1,
    });
    await buildMonthBundle({
      pool: secondPool,
      sourceAccountId,
      archiveMonth: '2026-01-01',
      directory: secondFiles,
      outputPath: secondBundle,
      batchSize: 1,
    });
    await extractMonthBundle({ inputPath: firstBundle, outputDirectory: extracted });
    const validated = await validateExtractedMonth({
      directory: extracted,
      expectedSourceAccountId: sourceAccountId,
      expectedArchiveMonth: '2026-01-01',
    });

    assert.deepEqual(await readFile(firstBundle), await readFile(secondBundle));
    assert.deepEqual(ARCHIVE_FILE_NAMES, [
      'manifest.json',
      'source-streams.json',
      'heart-rate-samples.csv',
      'calorie-intervals.csv',
    ]);
    assert.equal(first.manifest.files['heart-rate-samples.csv'].count, 2);
    assert.equal(first.manifest.files['calorie-intervals.csv'].count, 1);
    assert.equal(validated.heartSampleCount, 2);
    assert.equal(validated.calorieIntervalCount, 1);
    assert.ok(firstPool.queries.every(({ params }) => params.at(-1) === 1));
    assert.ok(firstPool.queries.some(({ sql }) => /ORDER BY sampled_at, source_stream_id/.test(sql)));
    assert.ok(firstPool.queries.every(({ sql }) => !/\bOFFSET\b/i.test(sql)));
    assert.match(
      await readFile(path.join(extracted, 'heart-rate-samples.csv'), 'utf8'),
      /"heart,one"/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('monthly bundle validation rejects row-count and content-hash mismatches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'health-bundle-invalid-'));
  const files = path.join(root, 'files');
  const extracted = path.join(root, 'extracted');
  const bundle = path.join(root, 'bundle.gz');

  try {
    await buildMonthBundle({
      pool: archivePool(),
      sourceAccountId,
      archiveMonth: '2026-01-01',
      directory: files,
      outputPath: bundle,
      batchSize: 2,
    });
    await extractMonthBundle({ inputPath: bundle, outputDirectory: extracted });
    await writeFile(
      path.join(extracted, 'heart-rate-samples.csv'),
      'source_stream_id,civil_date,sampled_at,utc_offset_seconds,beats_per_minute,upstream_sample_id\n',
    );
    await assert.rejects(
      validateExtractedMonth({
        directory: extracted,
        expectedSourceAccountId: sourceAccountId,
        expectedArchiveMonth: '2026-01-01',
      }),
      /hash mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('monthly bundle validation rejects measurements with an unreferenced source stream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'health-bundle-reference-'));
  const files = path.join(root, 'files');
  const extracted = path.join(root, 'extracted');
  const bundle = path.join(root, 'bundle.gz');

  try {
    await buildMonthBundle({
      pool: archivePool(), sourceAccountId, archiveMonth: '2026-01-01',
      directory: files, outputPath: bundle, batchSize: 2,
    });
    await extractMonthBundle({ inputPath: bundle, outputDirectory: extracted });
    const heartPath = path.join(extracted, 'heart-rate-samples.csv');
    const missingStream = '33333333-3333-3333-3333-333333333333';
    const heartCsv = (await readFile(heartPath, 'utf8')).replaceAll(sourceStreamId, missingStream);
    await writeFile(heartPath, heartCsv);
    const manifestPath = path.join(extracted, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['heart-rate-samples.csv'].sha256 = crypto
      .createHash('sha256').update(heartCsv).digest('hex');
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      validateExtractedMonth({
        directory: extracted,
        expectedSourceAccountId: sourceAccountId,
        expectedArchiveMonth: '2026-01-01',
      }),
      /unknown source stream/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
