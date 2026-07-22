import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMonthBundle } from '../lib/archive/bundle.js';
import { readCsvRows } from '../lib/archive/csv.js';
import { importExtractedMonth } from '../lib/archive/import.js';

const sourceAccountId = '11111111-1111-1111-1111-111111111111';
const sourceStreamId = '22222222-2222-2222-2222-222222222222';
const exactHearts = [
  ['2026-01-01T12:00:00.000123Z', null],
  ['2026-01-01T12:00:00.000124Z', ''],
  ['2026-01-01T12:00:00.000125Z', '\\N'],
  ['2026-01-01T12:00:00.000126Z', 'quote"\nline'],
].map(([sampledAt, upstreamSampleId], index) => ({
  source_stream_id: sourceStreamId,
  civil_date: '2026-01-01',
  sampled_at: sampledAt,
  utc_offset_seconds: index === 0 ? null : 50400,
  beats_per_minute: `${70 + index}.00`,
  upstream_sample_id: upstreamSampleId,
}));
const exactCalories = [{
  source_stream_id: sourceStreamId,
  civil_date: '2026-01-01',
  interval_type: 'active',
  start_at: '2026-01-01T13:00:00.000456Z',
  end_at: '2026-01-01T13:05:00.000789Z',
  utc_offset_seconds: 50400,
  kilocalories: '1.2500',
  upstream_sample_id: '\\N',
}];

function exactSourcePool() {
  const queries = [];
  let heartQueries = 0;
  return {
    queries,
    get heartQueries() { return heartQueries; },
    async query(sql, params) {
      queries.push({ sql, params });
      const limit = params.at(-1);
      if (sql.includes('FROM source_streams')) {
        return {
          rows: params[2] ? [] : [{
            id: sourceStreamId,
            metadata: { dataType: 'heart-rate' },
            metadata_hash: 'a'.repeat(64),
          }],
        };
      }
      if (sql.includes('FROM heart_rate_samples_compact')) {
        heartQueries += 1;
        if (heartQueries > 10) throw new Error('archive keyset cursor did not advance');
        const cursorTime = params[2];
        const cursorStream = params[3];
        const rows = exactHearts.filter((row) => !cursorTime
          || row.sampled_at > cursorTime
          || (row.sampled_at === cursorTime && row.source_stream_id > cursorStream)).slice(0, limit);
        const canonical = /civil_date::text AS civil_date/i.test(sql)
          && /to_char\(sampled_at AT TIME ZONE 'UTC'/i.test(sql);
        return {
          rows: rows.map((row) => ({
            ...row,
            civil_date: canonical
              ? row.civil_date
              : new Date(`${row.civil_date}T00:00:00+14:00`),
            sampled_at: canonical ? row.sampled_at : new Date(row.sampled_at),
          })),
        };
      }
      if (sql.includes('FROM calorie_intervals_compact')) {
        const [cursorStart, cursorType, cursorStream] = params.slice(2, 5);
        const rows = exactCalories.filter((row) => !cursorStart
          || [row.start_at, row.interval_type, row.source_stream_id].join(':')
            > [cursorStart, cursorType, cursorStream].join(':')).slice(0, limit);
        const canonical = /civil_date::text AS civil_date/i.test(sql)
          && /to_char\(start_at AT TIME ZONE 'UTC'/i.test(sql)
          && /to_char\(end_at AT TIME ZONE 'UTC'/i.test(sql);
        return {
          rows: rows.map((row) => ({
            ...row,
            civil_date: canonical
              ? row.civil_date
              : new Date(`${row.civil_date}T00:00:00+14:00`),
            start_at: canonical ? row.start_at : new Date(row.start_at),
            end_at: canonical ? row.end_at : new Date(row.end_at),
          })),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

async function rowsFrom(filePath) {
  const rows = [];
  for await (const row of readCsvRows(filePath)) rows.push(row);
  return rows;
}

test('bundle export preserves microseconds, positive-offset civil dates, and monotonic cursors', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'health-archive-exact-'));
  const files = path.join(root, 'files');
  const pool = exactSourcePool();
  try {
    const result = await buildMonthBundle({
      pool,
      sourceAccountId,
      archiveMonth: '2026-01-01',
      directory: files,
      outputPath: path.join(root, 'bundle.gz'),
      batchSize: 1,
    });
    const hearts = await rowsFrom(path.join(files, 'heart-rate-samples.csv'));
    const calories = await rowsFrom(path.join(files, 'calorie-intervals.csv'));

    assert.equal(pool.heartQueries, exactHearts.length + 1);
    assert.deepEqual(hearts.slice(1).map((row) => row[1]), Array(4).fill('2026-01-01'));
    assert.deepEqual(hearts.slice(1).map((row) => row[2]), exactHearts.map((row) => row.sampled_at));
    assert.equal(calories[1][3], exactCalories[0].start_at);
    assert.equal(calories[1][4], exactCalories[0].end_at);
    assert.equal(result.measurementStartedAt, exactHearts[0].sampled_at);
    assert.equal(result.measurementEndedAt, exactCalories[0].end_at);
    assert.equal(result.manifest.schemaVersion, 2);
    assert.equal(result.manifest.nullableTextEncoding, 'tagged-v1');
    assert.deepEqual(hearts.slice(1).map((row) => row[5]), [
      'N', 'S', 'S\\N', 'Squote"\nline',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('archive import restores microseconds and all nullable upstream string cases distinctly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'health-archive-import-exact-'));
  const files = path.join(root, 'files');
  const captured = { heart: [], calories: [] };
  const client = {
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT 1 FROM source_accounts')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO source_streams')) return { rows: [{ id: sourceStreamId }], rowCount: 1 };
      if (sql.includes('INSERT INTO heart_rate_samples_compact')) {
        captured.heart.push(...params);
        return { rows: [], rowCount: exactHearts.length };
      }
      if (sql.includes('INSERT INTO calorie_intervals_compact')) {
        captured.calories.push(...params);
        return { rows: [], rowCount: exactCalories.length };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };
  const targetPool = { async connect() { return client; } };
  try {
    await buildMonthBundle({
      pool: exactSourcePool(),
      sourceAccountId,
      archiveMonth: '2026-01-01',
      directory: files,
      outputPath: path.join(root, 'bundle.gz'),
      batchSize: 10,
    });
    await importExtractedMonth({ directory: files, targetPool, batchSize: 10 });
    const restoredHearts = Array.from(
      { length: exactHearts.length },
      (_unused, index) => captured.heart.slice(index * 7, index * 7 + 7),
    );
    assert.deepEqual(restoredHearts.map((row) => row[3]), exactHearts.map((row) => row.sampled_at));
    assert.deepEqual(restoredHearts.map((row) => row[6]), [null, '', '\\N', 'quote"\nline']);
    assert.equal(captured.calories[4], exactCalories[0].start_at);
    assert.equal(captured.calories[5], exactCalories[0].end_at);
    assert.equal(captured.calories[8], '\\N');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
