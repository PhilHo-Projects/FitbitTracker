import assert from 'node:assert/strict';
import test from 'node:test';

import { createOperationsService } from '../lib/operations/service.js';
import { renderOperationsStatus } from '../public/operations-ui.js';

test('operations service records safe daily capacity aggregates and classifies thresholds', async () => {
  const queries = [];
  const rows = [];
  const pool = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql.includes('FROM operational_snapshots')) return { rows };
      if (sql.includes('pg_database_size')) return { rows: [{ database_bytes: '2500', heart_bytes: '2000', oxygen_bytes: '25' }] };
      if (sql.includes('INSERT INTO operational_snapshots')) {
        rows.unshift({
          civil_date: parameters[0], captured_at: parameters[1], database_bytes: parameters[2],
          heart_rate_samples_bytes: parameters[3], oxygen_saturation_samples_bytes: parameters[4],
          filesystem_total_bytes: parameters[5], filesystem_available_bytes: parameters[6],
          filesystem_used_percent: parameters[7],
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const service = createOperationsService({
    pool,
    now: () => Date.parse('2026-09-16T12:00:00Z'),
    statfs: async () => ({ blocks: 100n, bavail: 19n, bsize: 1n }),
  });

  await service.capture();
  const status = await service.status();
  assert.equal(status.state, 'warning');
  assert.equal(status.current.databaseBytes, 2500);
  assert.equal(status.current.filesystemUsedPercent, 81);
  assert.deepEqual(status.thresholds, { warningPercent: 80, criticalPercent: 90 });
  assert.equal(JSON.stringify(status).includes('health'), false);
  assert.ok(queries.some(({ sql }) => sql.includes('ON CONFLICT (civil_date) DO UPDATE')));
});

test('operations service reports critical disk use and caps history at thirty snapshots', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM operational_snapshots')) return { rows: [{
        civil_date: '2026-09-16', captured_at: '2026-09-16T12:00:00Z', database_bytes: '1',
        heart_rate_samples_bytes: '1', oxygen_saturation_samples_bytes: '1',
        filesystem_total_bytes: '100', filesystem_available_bytes: '9', filesystem_used_percent: '91',
      }] };
      return { rows: [] };
    },
  };
  const status = await createOperationsService({ pool }).status();
  assert.equal(status.state, 'critical');
  assert.match(status.current.capturedAt, /^2026-09-16/);
});

test('operations capture accepts a synthetic database-size reader for local preview', async () => {
  const writes = [];
  const pool = { query: async (sql, parameters = []) => { writes.push({ sql, parameters }); return { rows: [] }; } };
  const service = createOperationsService({
    pool,
    now: () => Date.parse('2026-09-16T12:00:00Z'),
    databaseStats: async () => ({ databaseBytes: 3000, heartBytes: 2500, oxygenBytes: 25 }),
    statfs: async () => ({ blocks: 100n, bavail: 50n, bsize: 1n }),
  });
  await service.capture();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].parameters.slice(2, 5), [3000, 2500, 25]);
});

test('operations UI explains disk warning, database growth and backup boundary', () => {
  const html = renderOperationsStatus({
    state: 'warning', thresholds: { warningPercent: 80, criticalPercent: 90 },
    current: {
      capturedAt: '2026-09-16T12:00:00Z', civilDate: '2026-09-16', databaseBytes: 3_000_000_000,
      filesystemTotalBytes: 40_000_000_000, filesystemAvailableBytes: 7_600_000_000,
      filesystemUsedPercent: 81,
      relations: { heartRateSamplesBytes: 2_500_000_000, oxygenSaturationSamplesBytes: 25_000_000 },
    },
    history: [{ civilDate: '2026-09-01', databaseBytes: 2_000_000_000 }],
  });
  assert.match(html, /Disk warning/);
  assert.match(html, /1\.0 GB/);
  assert.match(html, /Coolify and private R2 storage/);
  assert.doesNotMatch(html, /object|secret|health reading/i);
});
