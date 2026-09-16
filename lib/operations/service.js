import { statfs as nodeStatfs } from 'node:fs/promises';

const WARNING_PERCENT = 80;
const CRITICAL_PERCENT = 90;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function civilDate(value, timeZone = 'America/Toronto') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function snapshot(row) {
  if (!row) return null;
  return {
    capturedAt: new Date(row.captured_at).toISOString(),
    civilDate: row.civil_date instanceof Date
      ? row.civil_date.toISOString().slice(0, 10)
      : String(row.civil_date).slice(0, 10),
    databaseBytes: finiteNumber(row.database_bytes),
    filesystemTotalBytes: finiteNumber(row.filesystem_total_bytes),
    filesystemAvailableBytes: finiteNumber(row.filesystem_available_bytes),
    filesystemUsedPercent: finiteNumber(row.filesystem_used_percent),
    relations: {
      heartRateSamplesBytes: finiteNumber(row.heart_rate_samples_bytes),
      oxygenSaturationSamplesBytes: finiteNumber(row.oxygen_saturation_samples_bytes),
    },
  };
}

export function createOperationsService({
  pool,
  now = () => Date.now(),
  statfs = (target) => nodeStatfs(target, { bigint: true }),
  databaseStats = async () => {
    const result = await pool.query(`
      SELECT
        pg_database_size(current_database())::text AS database_bytes,
        COALESCE(pg_total_relation_size('heart_rate_samples'), 0)::text AS heart_bytes,
        COALESCE(pg_total_relation_size('oxygen_saturation_samples'), 0)::text AS oxygen_bytes
    `);
    const row = result.rows[0];
    return {
      databaseBytes: finiteNumber(row.database_bytes),
      heartBytes: finiteNumber(row.heart_bytes),
      oxygenBytes: finiteNumber(row.oxygen_bytes),
    };
  },
  filesystemPath = '/',
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console,
} = {}) {
  let timer = null;

  async function capture() {
    const [database, filesystem] = await Promise.all([
      databaseStats(),
      statfs(filesystemPath),
    ]);
    const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const usedPercent = Math.round((1 - availableBytes / totalBytes) * 10_000) / 100;
    const capturedAt = new Date(now());
    await pool.query(
      `INSERT INTO operational_snapshots (
        civil_date, captured_at, database_bytes, heart_rate_samples_bytes,
        oxygen_saturation_samples_bytes, filesystem_total_bytes,
        filesystem_available_bytes, filesystem_used_percent
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (civil_date) DO UPDATE SET
        captured_at=EXCLUDED.captured_at,
        database_bytes=EXCLUDED.database_bytes,
        heart_rate_samples_bytes=EXCLUDED.heart_rate_samples_bytes,
        oxygen_saturation_samples_bytes=EXCLUDED.oxygen_saturation_samples_bytes,
        filesystem_total_bytes=EXCLUDED.filesystem_total_bytes,
        filesystem_available_bytes=EXCLUDED.filesystem_available_bytes,
        filesystem_used_percent=EXCLUDED.filesystem_used_percent`,
      [
        civilDate(capturedAt), capturedAt.toISOString(), finiteNumber(database.databaseBytes),
        finiteNumber(database.heartBytes), finiteNumber(database.oxygenBytes), totalBytes,
        availableBytes, usedPercent,
      ],
    );
  }

  async function status() {
    const result = await pool.query(`
      SELECT * FROM operational_snapshots
      ORDER BY civil_date DESC
      LIMIT 30
    `);
    const history = result.rows.map(snapshot);
    const current = history[0] ?? null;
    const state = !current || current.filesystemUsedPercent < WARNING_PERCENT
      ? 'ok'
      : current.filesystemUsedPercent >= CRITICAL_PERCENT ? 'critical' : 'warning';
    return {
      state,
      thresholds: { warningPercent: WARNING_PERCENT, criticalPercent: CRITICAL_PERCENT },
      current,
      history,
    };
  }

  function start() {
    const run = () => capture().catch(() => logger.error('Operational capacity snapshot failed'));
    run();
    timer = setInterval(run, intervalMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return { capture, status, start, stop };
}

export const operationsThresholds = { warningPercent: WARNING_PERCENT, criticalPercent: CRITICAL_PERCENT };
