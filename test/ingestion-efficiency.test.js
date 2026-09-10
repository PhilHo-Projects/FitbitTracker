import assert from 'node:assert/strict';
import test from 'node:test';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { createOxygenDatabase, oxygenAccountId, oxygenPoint, oxygenDailyPoint } from '../test-support/oxygen.js';
import { normalizeOxygenSaturationSamples, normalizeDailyOxygenSaturation } from '../lib/metrics/oxygen-normalizer.js';
import { normalizeSleepVitals } from '../lib/metrics/sleep-vitals.js';

const oldTimestamp = '2001-01-01T00:00:00.000Z';
const heart = { providerKey: 'heart', civilDate: '2026-09-07', sampledAt: '2026-09-07T01:00:00Z', beatsPerMinute: 70, sourceFields: {} };
const calorie = { providerKey: 'calorie', civilDate: '2026-09-07', metricType: 'active', startTime: '2026-09-07T01:00:00Z', endTime: '2026-09-07T02:00:00Z', kilocalories: 0, sourceFields: {} };
const session = { id: 'sleep', date: '2026-09-07', startTime: '2026-09-07T01:00:00Z', endTime: '2026-09-07T02:00:00Z', type: 'stages', durationMinutes: 60, stages: [{ type: 'light', startTime: '2026-09-07T01:00:00Z', endTime: '2026-09-07T02:00:00Z', durationMinutes: 60 }] };
const cases = [
  ['heart_rate_samples', 'upsertHeartSamples', heart],
  ['calorie_intervals', 'upsertCalorieIntervals', calorie],
  ['heart_rate_daily_summaries', 'upsertRestingHeartRateDaily', { civilDate: '2026-09-07', restingBpm: 60, sourceFields: {} }],
  ['oxygen_saturation_samples', 'upsertOxygenSaturationSamples', normalizeOxygenSaturationSamples({ dataPoints: [oxygenPoint()] })[0]],
  ['oxygen_saturation_daily_summaries', 'upsertDailyOxygenSaturation', normalizeDailyOxygenSaturation({ dataPoints: [oxygenDailyPoint()] })[0]],
  ['sleep_sessions', 'upsertSleepSessions', session],
];

for (const [table, method, record] of cases) {
  test(`${table}: repeat imports leave rows untouched and metadata corrections still apply`, async () => {
    const pool = await createOxygenDatabase();
    try {
      const writer = createMetricWriter(pool);
      await writer[method](oxygenAccountId, [record]);
      await pool.query(`UPDATE ${table} SET updated_at = $1`, [oldTimestamp]);
      await writer[method](oxygenAccountId, [structuredClone(record)]);
      const unchanged = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
      assert.equal(unchanged.updated_at.toISOString(), oldTimestamp);
      const corrected = { ...record, sourceFields: { correction: true } };
      await writer[method](oxygenAccountId, [corrected]);
      const changed = (await pool.query(`SELECT * FROM ${table}`)).rows[0];
      assert.notEqual(changed.updated_at.toISOString(), oldTimestamp);
      assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 1);
    } finally { await pool.end(); }
  });
}

test('heart imports retain last correction for a duplicate key and preserve null transitions', async () => {
  const pool = await createOxygenDatabase();
  try {
    const writer = createMetricWriter(pool);
    await writer.upsertHeartSamples(oxygenAccountId, [heart, { ...heart, beatsPerMinute: 80, utcOffsetSeconds: 0 }]);
    let row = (await pool.query('SELECT * FROM heart_rate_samples')).rows[0];
    assert.equal(Number(row.beats_per_minute), 80);
    assert.equal(row.utc_offset_seconds, 0);
    await writer.upsertHeartSamples(oxygenAccountId, [{ ...heart, beatsPerMinute: 80 }]);
    row = (await pool.query('SELECT * FROM heart_rate_samples')).rows[0];
    assert.equal(row.utc_offset_seconds, null);
  } finally { await pool.end(); }
});

test('sleep physiology repeat imports preserve updated_at and accept value corrections', async () => {
  const pool = await createOxygenDatabase();
  try {
    const writer = createMetricWriter(pool);
    const metric = 'daily-heart-rate-variability';
    const rows = normalizeSleepVitals(metric, { dataPoints: [{ name: 'hrv', dailyHeartRateVariability: { date: { year: 2026, month: 9, day: 7 }, rmssd: 40 } }] });
    assert.equal(rows.length, 1);
    await writer.upsertSleepVitals(oxygenAccountId, metric, rows);
    await pool.query('UPDATE sleep_hrv_daily SET updated_at=$1', [oldTimestamp]);
    await writer.upsertSleepVitals(oxygenAccountId, metric, rows);
    assert.equal((await pool.query('SELECT updated_at FROM sleep_hrv_daily')).rows[0].updated_at.toISOString(), oldTimestamp);
    await writer.upsertSleepVitals(oxygenAccountId, metric, [{ ...rows[0], rmssd_ms: 42 }]);
    assert.equal(Number((await pool.query('SELECT rmssd_ms FROM sleep_hrv_daily')).rows[0].rmssd_ms), 42);
  } finally { await pool.end(); }
});
