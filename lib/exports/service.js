import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import archiver from 'archiver';

import { columnDefinitions, EXPORT_COLUMNS, toCsv, toCsvStream } from './csv.js';
import { renderSummaryPng } from './png.js';

const EXPORT_TYPES = ['analysis', 'archive', 'png'];
const METRICS = ['sleep', 'heart', 'calories'];
const RETENTION_MS = 24 * 60 * 60 * 1_000;

function dateOnly(value) {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    exportType: row.export_type,
    status: row.status,
    startDate: dateOnly(row.start_date),
    endDateExclusive: dateOnly(row.end_date_exclusive),
    metrics: parseJson(row.metrics, []),
    detailLevel: row.detail_level,
    includeJournal: Boolean(row.include_journal),
    includePng: Boolean(row.include_png),
    filePath: row.file_path,
    fileName: row.file_name,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    expiresAt: iso(row.expires_at),
    errorMessage: row.error_message,
    createdAt: iso(row.created_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
  };
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function validate(input) {
  if (!EXPORT_TYPES.includes(input.exportType)) {
    throw Object.assign(new Error('exportType must be analysis, archive, or png'), { status: 400 });
  }
  if (
    !validDate(input.startDate) ||
    !validDate(input.endDateExclusive) ||
    input.startDate >= input.endDateExclusive
  ) {
    throw Object.assign(new Error('startDate and endDateExclusive must form a valid closed-open range'), {
      status: 400,
    });
  }
  const metrics = [...new Set(Array.isArray(input.metrics) ? input.metrics : METRICS)];
  if (!metrics.length || metrics.some((metric) => !METRICS.includes(metric))) {
    throw Object.assign(new Error('metrics must contain sleep, heart, and/or calories'), { status: 400 });
  }
  return {
    exportType: input.exportType,
    startDate: input.startDate,
    endDateExclusive: input.endDateExclusive,
    metrics,
    detailLevel: input.exportType === 'archive' ? 'full' : 'analysis',
    includeJournal: Boolean(input.includeJournal),
    includePng: input.exportType === 'png' || Boolean(input.includePng),
  };
}

function previousDay(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function journalMarkdown(dataset) {
  const lines = [
    '# Journal context',
    '',
    `Range: ${dataset.range.startDate} through ${previousDay(dataset.range.endDateExclusive)}`,
    `Timezone: ${dataset.timezone}`,
    '',
  ];
  for (const entry of [...dataset.journal].reverse()) {
    lines.push(
      `## ${entry.civilDate} — ${entry.occurredAt}`,
      '',
      entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : 'Tags: none',
      '',
      entry.body,
      '',
    );
  }
  if (!dataset.journal.length) lines.push('_No journal entries in this range._', '');
  return lines.join('\n');
}

function inventoryEntry(name, format, description, rows = null) {
  return { name, format, description, rows };
}

async function writeZip(filePath, entries) {
  const temporary = `${filePath}.part`;
  await rm(temporary, { force: true });
  try {
    const output = createWriteStream(temporary, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.data, { name: entry.name });
    await archive.finalize();
    await finished(output);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function safeMessage(error) {
  return String(error?.message || 'Export generation failed').slice(0, 500);
}

export function publicExportJob(job) {
  if (!job) return null;
  const { filePath: _filePath, ...publicFields } = job;
  return publicFields;
}

export function createExportService({
  pool,
  datasetService,
  storageDirectory,
  now = () => Date.now(),
  rowLocks = true,
  pollIntervalMs = 2_000,
}) {
  const root = path.resolve(storageDirectory);
  let timer = null;
  let pumping = false;

  async function sourceAccountId() {
    return (
      await pool.query('SELECT id FROM source_accounts ORDER BY created_at LIMIT 1')
    ).rows[0]?.id;
  }

  async function claim() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidate = (
        await client.query(
          `SELECT *
           FROM export_jobs
           WHERE status = 'queued'
           ORDER BY created_at, id
           LIMIT 1${rowLocks ? ' FOR UPDATE SKIP LOCKED' : ''}`,
        )
      ).rows[0];
      if (!candidate) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = (
        await client.query(
          `UPDATE export_jobs
           SET status = 'running', started_at = $1, error_message = NULL
           WHERE id = $2 AND status = 'queued'
           RETURNING *`,
          [new Date(now()), candidate.id],
        )
      ).rows[0];
      await client.query('COMMIT');
      return shape(claimed);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function generate(job) {
    const range = {
      startDate: job.startDate,
      endDateExclusive: job.endDateExclusive,
    };
    const dataset = await datasetService.buildAnalysisDataset(
      range,
      job.metrics,
      job.detailLevel,
      job.includeJournal,
      { loadRawRecords: job.detailLevel !== 'full' },
    );
    const rawCoverage = job.detailLevel === 'full'
      ? await datasetService.rawCoverage(range, job.metrics)
      : null;
    await mkdir(root, { recursive: true });
    const stem = `health-${job.startDate}-to-${previousDay(job.endDateExclusive)}-${job.exportType}-${job.id.slice(0, 8)}`;

    if (job.exportType === 'png') {
      const fileName = `${stem}.png`;
      const filePath = path.join(root, fileName);
      const temporary = `${filePath}.part`;
      const png = await renderSummaryPng(dataset);
      await rm(temporary, { force: true });
      try {
        await import('node:fs/promises').then(({ writeFile }) =>
          writeFile(temporary, png, { flag: 'wx' }),
        );
        await rename(temporary, filePath);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      return { fileName, filePath, sizeBytes: (await stat(filePath)).size };
    }

    const inventory = [
      inventoryEntry('manifest.json', 'json', 'Schema, units, sources, coverage, and file inventory.'),
      inventoryEntry(
        'daily-summary.csv',
        'csv',
        'One normalized joined health summary per available civil date.',
        dataset.dailySummaries.length,
      ),
    ];
    const entries = [
      {
        name: 'daily-summary.csv',
        data: toCsv(dataset.dailySummaries, EXPORT_COLUMNS['daily-summary.csv']),
      },
    ];

    if (job.metrics.includes('sleep')) {
      inventory.push(
        inventoryEntry(
          'sleep-sessions.csv',
          'csv',
          'Sleep sessions with exact UTC timestamps and source offsets.',
          dataset.sleepSessions.length,
        ),
        inventoryEntry(
          'sleep-stages.csv',
          'csv',
          'Chronological stages joined to their sleep session.',
          dataset.sleepStages.length,
        ),
      );
      entries.push(
        {
          name: 'sleep-sessions.csv',
          data: toCsv(dataset.sleepSessions, EXPORT_COLUMNS['sleep-sessions.csv']),
        },
        {
          name: 'sleep-stages.csv',
          data: toCsv(dataset.sleepStages, EXPORT_COLUMNS['sleep-stages.csv']),
        },
      );
    }

    if (job.detailLevel === 'full') {
      const counts = await datasetService.rawCounts(range, job.metrics);
      if (job.metrics.includes('heart')) {
        inventory.push(
          inventoryEntry(
            'heart-rate-samples.csv',
            'csv',
            'Raw-granularity archived heart-rate samples.',
            counts.heartRateSamples,
          ),
        );
        entries.push({
          name: 'heart-rate-samples.csv',
          data: Readable.from(
            toCsvStream(
              await datasetService.streamHeartRateSamples(range),
              EXPORT_COLUMNS['heart-rate-samples.csv'],
            ),
          ),
        });
      }
      if (job.metrics.includes('calories')) {
        inventory.push(
          inventoryEntry(
            'calorie-intervals.csv',
            'csv',
            'Raw total, active, and basal calorie intervals kept as separate metric types.',
            counts.calorieIntervals,
          ),
        );
        entries.push({
          name: 'calorie-intervals.csv',
          data: Readable.from(
            toCsvStream(
              await datasetService.streamCalorieIntervals(range),
              EXPORT_COLUMNS['calorie-intervals.csv'],
            ),
          ),
        });
      }
    }

    if (job.includeJournal) {
      inventory.push(
        inventoryEntry(
          'journal.md',
          'markdown',
          'Decrypted journal context, included only by explicit request.',
          dataset.journal.length,
        ),
      );
      entries.push({ name: 'journal.md', data: journalMarkdown(dataset) });
    }

    if (job.includePng) {
      inventory.push(
        inventoryEntry(
          'summary.png',
          'png',
          'Purpose-built fixed-layout visual summary generated from archived values.',
        ),
      );
      entries.push({ name: 'summary.png', data: await renderSummaryPng(dataset) });
    }

    const manifest = {
      schemaVersion: dataset.schemaVersion,
      generatedAt: new Date(now()).toISOString(),
      timezone: dataset.timezone,
      units: dataset.units,
      sources: dataset.sources,
      range: dataset.range,
      metrics: dataset.metrics,
      detailLevel: job.detailLevel,
      journalIncluded: job.includeJournal,
      derivationFlags: dataset.derivationFlags,
      coverageWarnings: dataset.coverageWarnings,
      rawCoverage,
      columns: columnDefinitions(),
      files: inventory,
    };
    entries.unshift({
      name: 'manifest.json',
      data: `${JSON.stringify(manifest, null, 2)}\n`,
    });

    const fileName = `${stem}.zip`;
    const filePath = path.join(root, fileName);
    await writeZip(filePath, entries);
    return { fileName, filePath, sizeBytes: (await stat(filePath)).size };
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (await service.runOnce()) {
        // Drain queued jobs serially so large archive streams do not compete for memory or I/O.
      }
      await service.cleanupExpired();
    } finally {
      pumping = false;
    }
  }

  const service = {
    async recoverStaleJobs({ staleAfterMs = 15 * 60 * 1000 } = {}) {
      const result = await pool.query(
        `UPDATE export_jobs
         SET status = 'queued', started_at = NULL,
           error_message = 'Recovered after interrupted generation'
         WHERE status = 'running' AND started_at <= $1
         RETURNING id`,
        [new Date(now() - staleAfterMs)],
      );
      return { jobs: result.rowCount };
    },

    async create(input) {
      const request = validate(input);
      const sourceAccount = await sourceAccountId();
      if (!sourceAccount) {
        throw Object.assign(new Error('No source account is configured'), { status: 409 });
      }
      const result = await pool.query(
        `INSERT INTO export_jobs (
          id, source_account_id, export_type, status, start_date, end_date_exclusive,
          metrics, detail_level, include_journal, include_png, created_at
        ) VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          crypto.randomUUID(),
          sourceAccount,
          request.exportType,
          request.startDate,
          request.endDateExclusive,
          JSON.stringify(request.metrics),
          request.detailLevel,
          request.includeJournal,
          request.includePng,
          new Date(now()),
        ],
      );
      return shape(result.rows[0]);
    },

    async list() {
      const result = await pool.query(
        `SELECT *
         FROM export_jobs
         ORDER BY created_at DESC
         LIMIT 50`,
      );
      return result.rows.map(shape);
    },

    async get(id) {
      return shape((await pool.query('SELECT * FROM export_jobs WHERE id = $1', [id])).rows[0]);
    },

    async download(id) {
      const job = await service.get(id);
      if (!job) throw Object.assign(new Error('Export job not found'), { status: 404 });
      if (job.status === 'expired') {
        throw Object.assign(new Error('Export file has expired'), { status: 410 });
      }
      if (job.status !== 'completed' || !job.filePath || !job.fileName) {
        throw Object.assign(new Error('Export is not ready'), { status: 409 });
      }
      const resolved = path.resolve(job.filePath);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw Object.assign(new Error('Export metadata is invalid'), { status: 500 });
      }
      return {
        filePath: resolved,
        fileName: job.fileName,
        contentType: job.exportType === 'png' ? 'image/png' : 'application/zip',
      };
    },

    async runOnce() {
      const job = await claim();
      if (!job) return null;
      try {
        const artifact = await generate(job);
        const expiresAt = new Date(now() + RETENTION_MS);
        const result = await pool.query(
          `UPDATE export_jobs
           SET status = 'completed', file_path = $1, file_name = $2, size_bytes = $3,
             expires_at = $4, completed_at = $5
           WHERE id = $6
           RETURNING *`,
          [
            artifact.filePath,
            artifact.fileName,
            artifact.sizeBytes,
            expiresAt,
            new Date(now()),
            job.id,
          ],
        );
        return shape(result.rows[0]);
      } catch (error) {
        await pool.query(
          `UPDATE export_jobs
           SET status = 'failed', error_message = $1, completed_at = $2
           WHERE id = $3`,
          [safeMessage(error), new Date(now()), job.id],
        );
        return service.get(job.id);
      }
    },

    async cleanupExpired() {
      const expired = await pool.query(
        `SELECT id, file_path
         FROM export_jobs
         WHERE status = 'completed' AND expires_at <= $1`,
        [new Date(now())],
      );
      let removed = 0;
      for (const row of expired.rows) {
        const resolved = row.file_path ? path.resolve(row.file_path) : null;
        if (resolved && resolved.startsWith(`${root}${path.sep}`)) {
          await rm(resolved, { force: true });
        }
        await pool.query(
          `UPDATE export_jobs
           SET status = 'expired', file_path = NULL
           WHERE id = $1`,
          [row.id],
        );
        removed += 1;
      }
      return { removed };
    },

    start() {
      if (timer) return;
      service
        .recoverStaleJobs()
        .catch(() => ({ jobs: 0 }))
        .finally(() => void pump());
      timer = setInterval(() => void pump(), pollIntervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  return service;
}
