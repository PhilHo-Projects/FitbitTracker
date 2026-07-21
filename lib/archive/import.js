import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ARCHIVE_SCHEMAS,
  readSourceStreamRows,
  validateExtractedMonth,
} from './bundle.js';
import { readCsvRows } from './csv.js';

function normalizedDatabaseIdentity(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('Import target must be a PostgreSQL URL');
  }
  return `${url.hostname.toLowerCase()}:${url.port || '5432'}/${url.pathname.replace(/^\//, '')}`;
}
export function assertSafeImportTarget({
  targetDatabaseUrl,
  currentDatabaseUrl,
  allowProductionTarget = false,
}) {
  if (!targetDatabaseUrl) throw new Error('Import requires an explicit target database URL');
  const targetIdentity = normalizedDatabaseIdentity(targetDatabaseUrl);
  if (allowProductionTarget) return;
  if (currentDatabaseUrl && targetIdentity === normalizedDatabaseIdentity(currentDatabaseUrl)) {
    throw new Error('Refusing to import into the current DATABASE_URL without --allow-production-target');
  }
  const target = new URL(targetDatabaseUrl);
  const localHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(target.hostname.toLowerCase());
  const databaseName = target.pathname.replace(/^\//, '').toLowerCase();
  const disposableName = /(?:^|[_-])(test|restore|disposable|dev)(?:$|[_-])/.test(databaseName);
  if (!localHost || !disposableName) {
    throw new Error('Refusing a production-looking target without --allow-production-target');
  }
}

function positiveBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
    throw new Error('Archive import batch size must be between 1 and 5000');
  }
  return parsed;
}

function nullable(value) {
  return value === '\\N' ? null : value;
}

function numeric(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Archive ${field} is not numeric`);
  return parsed;
}

async function insertBatch(client, table, columns, conflict, updateColumns, rows) {
  if (!rows.length) return;
  const params = [];
  const groups = rows.map((row) => {
    const placeholders = row.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  await client.query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES ${groups.join(', ')}
     ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET
       ${updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')},
       updated_at = CURRENT_TIMESTAMP`,
    params,
  );
}

async function importCsv({
  client,
  filePath,
  schema,
  batchSize,
  mapRow,
  table,
  columns,
  conflict,
  updateColumns,
}) {
  let header = true;
  let count = 0;
  let batch = [];
  for await (const row of readCsvRows(filePath)) {
    if (header) {
      header = false;
      if (JSON.stringify(row) !== JSON.stringify(schema)) throw new Error('Archive import CSV schema mismatch');
      continue;
    }
    batch.push(mapRow(row));
    count += 1;
    if (batch.length >= batchSize) {
      await insertBatch(client, table, columns, conflict, updateColumns, batch);
      batch = [];
    }
  }
  await insertBatch(client, table, columns, conflict, updateColumns, batch);
  return count;
}

export async function importExtractedMonth({ directory, targetPool, batchSize = 1000 }) {
  const bound = positiveBatchSize(batchSize);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  await validateExtractedMonth({
    directory,
    expectedSourceAccountId: manifest.sourceAccountId,
    expectedArchiveMonth: manifest.archiveMonth,
  });
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const account = await client.query('SELECT 1 FROM source_accounts WHERE id = $1', [manifest.sourceAccountId]);
    if (!account.rows.length) {
      throw new Error('Import target must already contain the archived source account');
    }
    const streamIds = new Map();
    let sourceStreams = 0;
    for await (const row of readSourceStreamRows(path.join(directory, 'source-streams.json'))) {
      const result = await client.query(
        `INSERT INTO source_streams (id, source_account_id, metadata, metadata_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_account_id, metadata_hash) DO UPDATE SET
           metadata = EXCLUDED.metadata, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [row.sourceStreamId, manifest.sourceAccountId, row.metadata, row.metadataHash],
      );
      streamIds.set(row.sourceStreamId, result.rows[0].id);
      sourceStreams += 1;
    }
    const mappedStream = (archivedId) => {
      const id = streamIds.get(archivedId);
      if (!id) throw new Error('Archive measurement references an unknown source stream');
      return id;
    };
    const heartSamples = await importCsv({
      client,
      filePath: path.join(directory, 'heart-rate-samples.csv'),
      schema: ARCHIVE_SCHEMAS['heart-rate-samples.csv'],
      batchSize: bound,
      table: 'heart_rate_samples_compact',
      columns: [
        'source_account_id', 'source_stream_id', 'civil_date', 'sampled_at',
        'utc_offset_seconds', 'beats_per_minute', 'upstream_sample_id',
      ],
      conflict: ['source_stream_id', 'sampled_at'],
      updateColumns: [
        'source_account_id', 'civil_date', 'utc_offset_seconds',
        'beats_per_minute', 'upstream_sample_id',
      ],
      mapRow: (row) => [
        manifest.sourceAccountId,
        mappedStream(row[0]),
        row[1],
        row[2],
        nullable(row[3]) === null ? null : numeric(row[3], 'UTC offset'),
        numeric(row[4], 'heart rate'),
        nullable(row[5]),
      ],
    });
    const calorieIntervals = await importCsv({
      client,
      filePath: path.join(directory, 'calorie-intervals.csv'),
      schema: ARCHIVE_SCHEMAS['calorie-intervals.csv'],
      batchSize: bound,
      table: 'calorie_intervals_compact',
      columns: [
        'source_account_id', 'source_stream_id', 'civil_date', 'interval_type',
        'start_at', 'end_at', 'utc_offset_seconds', 'kilocalories', 'upstream_sample_id',
      ],
      conflict: ['source_stream_id', 'interval_type', 'start_at'],
      updateColumns: [
        'source_account_id', 'civil_date', 'end_at', 'utc_offset_seconds',
        'kilocalories', 'upstream_sample_id',
      ],
      mapRow: (row) => [
        manifest.sourceAccountId,
        mappedStream(row[0]),
        row[1],
        row[2],
        row[3],
        row[4],
        nullable(row[5]) === null ? null : numeric(row[5], 'UTC offset'),
        numeric(row[6], 'calories'),
        nullable(row[7]),
      ],
    });
    await client.query('COMMIT');
    return { sourceStreams, heartSamples, calorieIntervals };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
