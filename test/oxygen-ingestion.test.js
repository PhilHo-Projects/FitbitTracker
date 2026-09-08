import assert from 'node:assert/strict';
import test from 'node:test';
import { createOxygenDatabase, oxygenAccountId, oxygenPoint, oxygenDailyPoint } from '../test-support/oxygen.js';
import { normalizeOxygenSaturationSamples as samples, normalizeDailyOxygenSaturation as daily } from '../lib/metrics/oxygen-normalizer.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';

test('oxygen storage retains precision and updates a stable record after value and date corrections', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const writer = createMetricWriter(pool);
  const initial = samples({ dataPoints: [oxygenPoint()] });
  await writer.upsertOxygenSaturationSamples(oxygenAccountId, initial);
  await writer.upsertOxygenSaturationSamples(oxygenAccountId, initial);
  await writer.upsertOxygenSaturationSamples(oxygenAccountId, samples({ dataPoints: [
    oxygenPoint({ percentage: 97.12345, time: '2026-09-07T04:00:00.123456789Z' }),
  ] }));
  const rows = (await pool.query('SELECT * FROM oxygen_saturation_samples')).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].percentage), 97.12345);
  assert.equal(rows[0].sample_time_text, '2026-09-07T04:00:00.123456789Z');
  assert.equal(rows[0].source_fields.oxygenSaturation.percentage, 97.12345);
  assert.equal(new Date(rows[0].civil_date).toISOString().slice(0, 10), '2026-09-07');
  await writer.upsertOxygenSaturationSamples(oxygenAccountId, []);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM oxygen_saturation_samples')).rows[0].count), 1);
});

test('oxygen keeps same-date provider records separate and clears corrected optional bounds', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const writer = createMetricWriter(pool, { compactWritesEnabled: true, compactWriter: new Proxy({}, {
    get() { throw new Error('Oxygen must not access compact storage'); },
  }) });
  const otherId = '65ce6554-70c7-48be-a688-d0079384fcb2';
  await pool.query(`INSERT INTO source_accounts (id, provider, provider_account_id) VALUES ($1, 'google-health', 'another')`, [otherId]);
  const records = daily({ dataPoints: [oxygenDailyPoint(), oxygenDailyPoint({ id: 'daily-2' })] });
  await writer.upsertDailyOxygenSaturation(oxygenAccountId, records);
  await writer.upsertDailyOxygenSaturation(oxygenAccountId, records);
  await writer.upsertDailyOxygenSaturation(otherId, records.slice(0, 1));
  const corrected = oxygenDailyPoint();
  delete corrected.dailyOxygenSaturation.lowerBoundPercentage;
  delete corrected.dailyOxygenSaturation.standardDeviationPercentage;
  await writer.upsertDailyOxygenSaturation(oxygenAccountId, daily({ dataPoints: [corrected] }));
  const rows = (await pool.query('SELECT * FROM oxygen_saturation_daily_summaries')).rows;
  assert.equal(rows.length, 3);
  const row = rows.find(r => r.source_account_id === oxygenAccountId && r.provider_id === corrected.name);
  assert.equal(row.lower_bound_percentage, null);
  assert.equal(row.standard_deviation_percentage, null);
  assert.equal(Number(rows.find(r => r.source_account_id === otherId).lower_bound_percentage), 93.125);
});

test('oxygen writer rejects impossible percentages using database constraints', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const writer = createMetricWriter(pool);
  const [row] = samples({ dataPoints: [oxygenPoint()] });
  await assert.rejects(writer.upsertOxygenSaturationSamples(oxygenAccountId, [{ ...row, percentage: 101 }]));
  await writer.upsertOxygenSaturationSamples(oxygenAccountId, [{ ...row, percentage: 0 }]);
  assert.equal(Number((await pool.query('SELECT percentage FROM oxygen_saturation_samples')).rows[0].percentage), 0);
});
