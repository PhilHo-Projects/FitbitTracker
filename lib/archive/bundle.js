import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import { encodeCsvRow, readCsvRows } from './csv.js';

const BUNDLE_MAGIC = Buffer.from('HHBUNDL1', 'ascii');
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_FILE_NAME_BYTES = 255;

export const ARCHIVE_FILE_NAMES = Object.freeze([
  'manifest.json',
  'source-streams.json',
  'heart-rate-samples.csv',
  'calorie-intervals.csv',
]);

export const ARCHIVE_SCHEMAS = Object.freeze({
  'source-streams.json': ['sourceStreamId', 'metadataHash', 'metadata'],
  'heart-rate-samples.csv': [
    'source_stream_id',
    'civil_date',
    'sampled_at',
    'utc_offset_seconds',
    'beats_per_minute',
    'upstream_sample_id',
  ],
  'calorie-intervals.csv': [
    'source_stream_id',
    'civil_date',
    'interval_type',
    'start_at',
    'end_at',
    'utc_offset_seconds',
    'kilocalories',
    'upstream_sample_id',
  ],
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function civilDate(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function instant(value) {
  if (typeof value === 'string') return new Date(value).toISOString();
  return value.toISOString();
}

function nextMonth(archiveMonth) {
  const start = new Date(`${archiveMonth}T00:00:00Z`);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    .toISOString().slice(0, 10);
}

function positiveBatchSize(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Archive batch size must be positive');
  return parsed;
}

async function writeAll(handle, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset);
    offset += bytesWritten;
  }
}

async function hashFile(filePath) {
  const hasher = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk);
  return hasher.digest('hex');
}

async function exportSourceStreams({ pool, sourceAccountId, archiveMonth, filePath, batchSize }) {
  const handle = await open(filePath, 'wx', 0o600);
  let cursor = null;
  let count = 0;
  try {
    await writeAll(handle, '[\n');
    for (;;) {
      const rows = (await pool.query(
        `SELECT stream.id, stream.metadata, stream.metadata_hash
         FROM source_streams AS stream
         WHERE stream.source_account_id = $1
           AND ($3::uuid IS NULL OR stream.id > $3::uuid)
           AND (
             EXISTS (
               SELECT 1 FROM heart_rate_samples_compact AS heart
               WHERE heart.source_account_id = $1 AND heart.source_stream_id = stream.id
                 AND heart.civil_date >= $2::date
                 AND heart.civil_date < $2::date + INTERVAL '1 month'
             ) OR EXISTS (
               SELECT 1 FROM calorie_intervals_compact AS calories
               WHERE calories.source_account_id = $1 AND calories.source_stream_id = stream.id
                 AND calories.civil_date >= $2::date
                 AND calories.civil_date < $2::date + INTERVAL '1 month'
             )
           )
         ORDER BY stream.id
         LIMIT $4`,
        [sourceAccountId, archiveMonth, cursor, batchSize],
      )).rows;
      if (!rows.length) break;
      for (const row of rows) {
        if (count) await writeAll(handle, ',\n');
        await writeAll(handle, stableJson({
          sourceStreamId: row.id,
          metadataHash: row.metadata_hash,
          metadata: row.metadata,
        }));
        count += 1;
      }
      cursor = rows.at(-1).id;
    }
    await writeAll(handle, '\n]\n');
  } finally {
    await handle.close();
  }
  return { count, sha256: await hashFile(filePath) };
}

async function exportHearts({ pool, sourceAccountId, archiveMonth, filePath, batchSize }) {
  const handle = await open(filePath, 'wx', 0o600);
  let cursorTime = null;
  let cursorStream = null;
  let count = 0;
  let startedAt = null;
  let endedAt = null;
  try {
    await writeAll(handle, encodeCsvRow(ARCHIVE_SCHEMAS['heart-rate-samples.csv']));
    for (;;) {
      const rows = (await pool.query(
        `SELECT source_stream_id, civil_date, sampled_at, utc_offset_seconds,
                beats_per_minute, upstream_sample_id
         FROM heart_rate_samples_compact
         WHERE source_account_id = $1
           AND civil_date >= $2::date
           AND civil_date < $2::date + INTERVAL '1 month'
           AND ($3::timestamptz IS NULL OR (sampled_at, source_stream_id) > ($3::timestamptz, $4::uuid))
         ORDER BY sampled_at, source_stream_id
         LIMIT $5`,
        [sourceAccountId, archiveMonth, cursorTime, cursorStream, batchSize],
      )).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const sampledAt = instant(row.sampled_at);
        await writeAll(handle, encodeCsvRow([
          row.source_stream_id,
          civilDate(row.civil_date),
          sampledAt,
          row.utc_offset_seconds ?? '\\N',
          row.beats_per_minute,
          row.upstream_sample_id ?? '\\N',
        ]));
        startedAt = startedAt === null || sampledAt < startedAt ? sampledAt : startedAt;
        endedAt = endedAt === null || sampledAt > endedAt ? sampledAt : endedAt;
        count += 1;
      }
      cursorTime = instant(rows.at(-1).sampled_at);
      cursorStream = rows.at(-1).source_stream_id;
    }
  } finally {
    await handle.close();
  }
  return { count, sha256: await hashFile(filePath), startedAt, endedAt };
}

async function exportCalories({ pool, sourceAccountId, archiveMonth, filePath, batchSize }) {
  const handle = await open(filePath, 'wx', 0o600);
  let cursorStart = null;
  let cursorType = null;
  let cursorStream = null;
  let count = 0;
  let startedAt = null;
  let endedAt = null;
  try {
    await writeAll(handle, encodeCsvRow(ARCHIVE_SCHEMAS['calorie-intervals.csv']));
    for (;;) {
      const rows = (await pool.query(
        `SELECT source_stream_id, civil_date, interval_type, start_at, end_at,
                utc_offset_seconds, kilocalories, upstream_sample_id
         FROM calorie_intervals_compact
         WHERE source_account_id = $1
           AND civil_date >= $2::date
           AND civil_date < $2::date + INTERVAL '1 month'
           AND ($3::timestamptz IS NULL OR (start_at, interval_type, source_stream_id)
             > ($3::timestamptz, $4::text, $5::uuid))
         ORDER BY start_at, interval_type, source_stream_id
         LIMIT $6`,
        [sourceAccountId, archiveMonth, cursorStart, cursorType, cursorStream, batchSize],
      )).rows;
      if (!rows.length) break;
      for (const row of rows) {
        const startAt = instant(row.start_at);
        const endAt = instant(row.end_at);
        await writeAll(handle, encodeCsvRow([
          row.source_stream_id,
          civilDate(row.civil_date),
          row.interval_type,
          startAt,
          endAt,
          row.utc_offset_seconds ?? '\\N',
          row.kilocalories,
          row.upstream_sample_id ?? '\\N',
        ]));
        startedAt = startedAt === null || startAt < startedAt ? startAt : startedAt;
        endedAt = endedAt === null || endAt > endedAt ? endAt : endedAt;
        count += 1;
      }
      cursorStart = instant(rows.at(-1).start_at);
      cursorType = rows.at(-1).interval_type;
      cursorStream = rows.at(-1).source_stream_id;
    }
  } finally {
    await handle.close();
  }
  return { count, sha256: await hashFile(filePath), startedAt, endedAt };
}

async function* bundleChunks(directory) {
  const header = Buffer.alloc(BUNDLE_MAGIC.length + 4);
  BUNDLE_MAGIC.copy(header);
  header.writeUInt32BE(ARCHIVE_FILE_NAMES.length, BUNDLE_MAGIC.length);
  yield header;
  for (const name of ARCHIVE_FILE_NAMES) {
    const nameBytes = Buffer.from(name, 'utf8');
    const details = await stat(path.join(directory, name));
    const fileHeader = Buffer.alloc(2 + 8);
    fileHeader.writeUInt16BE(nameBytes.length);
    fileHeader.writeBigUInt64BE(BigInt(details.size), 2);
    yield fileHeader;
    yield nameBytes;
    yield* createReadStream(path.join(directory, name));
  }
}

async function compressBundle(directory, outputPath) {
  await pipeline(
    Readable.from(bundleChunks(directory)),
    createGzip({ level: 9, mtime: 0 }),
    createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
  );
}

export async function buildMonthBundle({
  pool,
  sourceAccountId,
  archiveMonth,
  directory,
  outputPath,
  batchSize = 1000,
}) {
  const boundedBatchSize = positiveBatchSize(batchSize);
  if (!/^\d{4}-\d{2}-01$/.test(archiveMonth)) {
    throw new Error('Archive month must be the first civil date of a month');
  }
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const sourceStreams = await exportSourceStreams({
    pool, sourceAccountId, archiveMonth,
    filePath: path.join(directory, 'source-streams.json'),
    batchSize: boundedBatchSize,
  });
  const heart = await exportHearts({
    pool, sourceAccountId, archiveMonth,
    filePath: path.join(directory, 'heart-rate-samples.csv'),
    batchSize: boundedBatchSize,
  });
  const calories = await exportCalories({
    pool, sourceAccountId, archiveMonth,
    filePath: path.join(directory, 'calorie-intervals.csv'),
    batchSize: boundedBatchSize,
  });
  const starts = [heart.startedAt, calories.startedAt].filter(Boolean).sort();
  const ends = [heart.endedAt, calories.endedAt].filter(Boolean).sort();
  const manifest = {
    format: 'health-hub-monthly-raw',
    schemaVersion: 1,
    bundleVersion: 1,
    sourceAccountId,
    archiveMonth,
    range: { startDate: archiveMonth, endDateExclusive: nextMonth(archiveMonth) },
    files: {
      'source-streams.json': { schema: ARCHIVE_SCHEMAS['source-streams.json'], ...sourceStreams },
      'heart-rate-samples.csv': { schema: ARCHIVE_SCHEMAS['heart-rate-samples.csv'], count: heart.count, sha256: heart.sha256 },
      'calorie-intervals.csv': { schema: ARCHIVE_SCHEMAS['calorie-intervals.csv'], count: calories.count, sha256: calories.sha256 },
    },
  };
  await writeFile(path.join(directory, 'manifest.json'), `${stableJson(manifest)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await compressBundle(directory, outputPath);
  return {
    manifest,
    heartSampleCount: heart.count,
    calorieIntervalCount: calories.count,
    measurementStartedAt: starts[0] ?? null,
    measurementEndedAt: ends.at(-1) ?? null,
  };
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (!result.bytesRead) throw new Error('Truncated health archive bundle');
    offset += result.bytesRead;
  }
  return buffer;
}

async function copyRange(handle, outputPath, position, length) {
  const output = await open(outputPath, 'wx', 0o600);
  const chunk = Buffer.alloc(64 * 1024);
  let remaining = length;
  let cursor = position;
  try {
    while (remaining > 0) {
      const requested = Math.min(chunk.length, remaining);
      const { bytesRead } = await handle.read(chunk, 0, requested, cursor);
      if (!bytesRead) throw new Error('Truncated health archive bundle file');
      await writeAll(output, chunk.subarray(0, bytesRead));
      cursor += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await output.close();
  }
  return cursor;
}

export async function extractMonthBundle({ inputPath, outputDirectory }) {
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const expandedPath = path.join(outputDirectory, '.bundle-expanded');
  try {
    await pipeline(
      createReadStream(inputPath),
      createGunzip(),
      createWriteStream(expandedPath, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await open(expandedPath, 'r');
    try {
      const fixed = await readExactly(handle, BUNDLE_MAGIC.length + 4, 0);
      if (!fixed.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
        throw new Error('Unsupported health archive bundle magic');
      }
      const count = fixed.readUInt32BE(BUNDLE_MAGIC.length);
      if (count !== ARCHIVE_FILE_NAMES.length) throw new Error('Unexpected archive file count');
      let position = fixed.length;
      for (const expectedName of ARCHIVE_FILE_NAMES) {
        const fileHeader = await readExactly(handle, 10, position);
        position += fileHeader.length;
        const nameLength = fileHeader.readUInt16BE();
        const fileLength = fileHeader.readBigUInt64BE(2);
        if (nameLength < 1 || nameLength > MAX_FILE_NAME_BYTES || fileLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Invalid health archive bundle entry');
        }
        const name = (await readExactly(handle, nameLength, position)).toString('utf8');
        position += nameLength;
        if (name !== expectedName || path.basename(name) !== name) {
          throw new Error(`Unexpected health archive file: ${name}`);
        }
        position = await copyRange(
          handle,
          path.join(outputDirectory, name),
          position,
          Number(fileLength),
        );
      }
      const details = await stat(expandedPath);
      if (position !== details.size) throw new Error('Trailing bytes in health archive bundle');
    } finally {
      await handle.close();
    }
    await rm(expandedPath, { force: true });
    return { files: [...ARCHIVE_FILE_NAMES] };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function countAndValidateCsv(
  filePath,
  expectedSchema,
  archiveMonth,
  endDateExclusive,
  sourceStreamIds,
) {
  let index = 0;
  for await (const row of readCsvRows(filePath)) {
    if (index === 0) {
      if (stableJson(row) !== stableJson(expectedSchema)) throw new Error('Archive CSV schema mismatch');
    } else {
      if (row.length !== expectedSchema.length) throw new Error('Archive CSV row schema mismatch');
      if (!sourceStreamIds.has(row[0])) {
        throw new Error('Archive measurement references an unknown source stream');
      }
      const civilDateIndex = expectedSchema.indexOf('civil_date');
      if (row[civilDateIndex] < archiveMonth || row[civilDateIndex] >= endDateExclusive) {
        throw new Error('Archive measurement is outside the manifest month');
      }
    }
    index += 1;
  }
  if (!index) throw new Error('Archive CSV is missing its header');
  return index - 1;
}

export async function* readSourceStreamRows(filePath) {
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let opened = false;
  let closed = false;
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!opened) {
      if (line !== '[') throw new Error('Archive source-streams schema mismatch');
      opened = true;
      continue;
    }
    if (line === ']') {
      closed = true;
      continue;
    }
    if (closed) throw new Error('Archive source-streams has trailing data');
    const json = line.endsWith(',') ? line.slice(0, -1) : line;
    yield JSON.parse(json);
  }
  if (!opened || !closed) throw new Error('Archive source-streams schema mismatch');
}

async function countSourceStreams(filePath) {
  let count = 0;
  const ids = new Set();
  for await (const row of readSourceStreamRows(filePath)) {
    if (stableJson(Object.keys(row).sort()) !== stableJson([...ARCHIVE_SCHEMAS['source-streams.json']].sort())) {
      throw new Error('Archive source-stream row schema mismatch');
    }
    count += 1;
    if (count > 100_000) throw new Error('Archive source-stream count exceeds the supported bound');
    if (ids.has(row.sourceStreamId)) throw new Error('Archive contains a duplicate source stream');
    ids.add(row.sourceStreamId);
  }
  return { count, ids };
}

export async function validateExtractedMonth({
  directory,
  expectedSourceAccountId,
  expectedArchiveMonth,
  expectedHeartSampleCount,
  expectedCalorieIntervalCount,
}) {
  const manifestPath = path.join(directory, 'manifest.json');
  if ((await stat(manifestPath)).size > MAX_MANIFEST_BYTES) throw new Error('Archive manifest is too large');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.format !== 'health-hub-monthly-raw'
    || manifest.schemaVersion !== 1
    || manifest.bundleVersion !== 1
  ) throw new Error('Unsupported archive manifest schema');
  if (manifest.sourceAccountId !== expectedSourceAccountId) throw new Error('Archive source account mismatch');
  if (manifest.archiveMonth !== expectedArchiveMonth) throw new Error('Archive month mismatch');
  if (
    manifest.range?.startDate !== expectedArchiveMonth
    || manifest.range?.endDateExclusive !== nextMonth(expectedArchiveMonth)
  ) throw new Error('Archive manifest range mismatch');

  for (const fileName of ARCHIVE_FILE_NAMES.slice(1)) {
    const description = manifest.files?.[fileName];
    if (!description || stableJson(description.schema) !== stableJson(ARCHIVE_SCHEMAS[fileName])) {
      throw new Error(`Archive schema mismatch for ${fileName}`);
    }
    const actualHash = await hashFile(path.join(directory, fileName));
    if (actualHash !== description.sha256) throw new Error(`Archive file hash mismatch: ${fileName}`);
  }
  const sourceStreams = await countSourceStreams(path.join(directory, 'source-streams.json'));
  const sourceStreamCount = sourceStreams.count;
  const heartSampleCount = await countAndValidateCsv(
    path.join(directory, 'heart-rate-samples.csv'),
    ARCHIVE_SCHEMAS['heart-rate-samples.csv'],
    expectedArchiveMonth,
    manifest.range.endDateExclusive,
    sourceStreams.ids,
  );
  const calorieIntervalCount = await countAndValidateCsv(
    path.join(directory, 'calorie-intervals.csv'),
    ARCHIVE_SCHEMAS['calorie-intervals.csv'],
    expectedArchiveMonth,
    manifest.range.endDateExclusive,
    sourceStreams.ids,
  );
  for (const [name, actual, expected] of [
    ['source stream', sourceStreamCount, manifest.files['source-streams.json'].count],
    ['heart sample', heartSampleCount, manifest.files['heart-rate-samples.csv'].count],
    ['calorie interval', calorieIntervalCount, manifest.files['calorie-intervals.csv'].count],
    ['catalog heart sample', heartSampleCount, expectedHeartSampleCount],
    ['catalog calorie interval', calorieIntervalCount, expectedCalorieIntervalCount],
  ]) {
    if (expected !== undefined && Number(expected) !== actual) {
      throw new Error(`Archive ${name} count mismatch`);
    }
  }
  return { manifest, sourceStreamCount, heartSampleCount, calorieIntervalCount };
}

export const HEALTH_ARCHIVE_BUNDLE_FORMAT = Object.freeze({
  magic: BUNDLE_MAGIC.toString('ascii'),
  bundleVersion: 1,
  compression: 'gzip',
});
