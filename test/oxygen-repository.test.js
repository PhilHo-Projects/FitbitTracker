import assert from 'node:assert/strict';
import test from 'node:test';
import { createOxygenDatabase, oxygenAccountId as account, oxygenPoint, oxygenDailyPoint } from '../test-support/oxygen.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { normalizeOxygenSaturationSamples as samples, normalizeDailyOxygenSaturation as daily } from '../lib/metrics/oxygen-normalizer.js';
import { createOxygenRepository, oxygenFetchStatus, validateOxygenRange } from '../lib/db/oxygen-repository.js';

test('night uses physical sleep window across midnight and excludes the exact end', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  await pool.query(`INSERT INTO sleep_sessions (id, source_account_id, provider_key, civil_date, start_time, end_time, start_offset_seconds, end_offset_seconds, sleep_type, duration_seconds)
    VALUES ('11111111-1111-4111-8111-111111111111', $1, 'sleep', '2026-09-07', '2026-09-07T03:00:00Z', '2026-09-07T11:00:00Z', -14400, -14400, 'stages', 28800)`, [account]);
  const writer = createMetricWriter(pool);
  await writer.upsertOxygenSaturationSamples(account, samples({ dataPoints: [
    oxygenPoint({ id: 'evening', time: '2026-09-07T03:59:59.999999999Z', percentage: 92 }),
    oxygenPoint({ id: 'morning', time: '2026-09-07T05:00:00Z' }),
    oxygenPoint({ id: 'last', time: '2026-09-07T10:59:59.999999999Z' }),
    oxygenPoint({ id: 'end', time: '2026-09-07T11:00:00Z' }),
  ] }));
  await writer.upsertDailyOxygenSaturation(account, daily({ dataPoints: [oxygenDailyPoint({ lower: 94 })] }));
  const result = await createOxygenRepository(pool).getDay(account, '2026-09-07');
  assert.equal(result.samples.length, 3);
  assert.equal(result.dataState, 'ready');
  assert.equal(result.sampleSummary.minimumPercentage, 92);
  assert.equal(result.dailySummary.lowerBoundPercentage, 94);
  assert.equal(result.window.startDate, '2026-09-06');
  assert.equal(result.window.endDateExclusive, '2026-09-08');
  assert.equal(result.sampleSummary.sleepWindowMinuteCount, 480);
  assert.equal(result.availability.raw, 'partial-local');
  assert.equal(result.availability.coldArchiveSupported, false);
  assert.ok(!JSON.stringify(result).includes('sourceFields'));
  assert.ok(!JSON.stringify(result).includes('source_metadata'));
});

test('daily and sample source choices are independent and same-source daily ambiguity is preserved', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  const writer = createMetricWriter(pool);
  await writer.upsertOxygenSaturationSamples(account, samples({ dataPoints: [
    oxygenPoint({ time: '2026-09-07T06:00:00Z' }),
    oxygenPoint({ id: 'other', time: '2026-09-07T06:00:00Z', dataSource: { device: { displayName: '<script>bad</script>' } } }),
  ] }));
  await writer.upsertDailyOxygenSaturation(account, daily({ dataPoints: [oxygenDailyPoint({ dataSource: {} }), oxygenDailyPoint({ id: 'ambiguous', dataSource: {} })] }));
  const repository = createOxygenRepository(pool);
  const unselected = await repository.getDay(account, '2026-09-07');
  assert.equal(unselected.dataState, 'source-selection-required');
  assert.equal(unselected.sampleSummary.sampleCount, 0);
  assert.equal(unselected.samples.length, 0);
  assert.equal(unselected.dailyCandidates.length, 2);
  assert.equal(unselected.dailySummary, null);
  const selected = await repository.getDay(account, '2026-09-07', { sampleSource: unselected.sampleSources[0].key });
  assert.equal(selected.dataState, 'samples-only');
  assert.equal(selected.window.kind, 'civil-day');
  assert.equal(selected.sampleSummary.observedMinuteFraction, null);
  assert.ok(selected.qualityFlags.includes('daily-ambiguous'));
  await assert.rejects(repository.getDay(account, '2026-09-07', { sampleSource: 'f'.repeat(64) }), { status: 400 });
});

test('trends have a row per date, zero counts as data, and averages give each daily value equal weight', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  await createMetricWriter(pool).upsertDailyOxygenSaturation(account, daily({ dataPoints: [
    oxygenDailyPoint({ average: 0 }), oxygenDailyPoint({ id: 'next', date: { year: 2026, month: 9, day: 9 }, average: 100 }),
  ] }));
  const result = await createOxygenRepository(pool).getRange(account, { startDate: '2026-09-07', endDateExclusive: '2026-09-10' });
  assert.equal(result.days.length, 3);
  assert.equal(result.days[1].dailySummary, null);
  assert.deepEqual(result.periodSummary, { averageDailyPercentage: 50, daysWithSummary: 2, requestedDays: 3, missingDays: 1 });
  assert.equal((await createOxygenRepository(pool).getDay(null, '2026-09-07')).dataState, 'not-synced');
});

test('fetch status requires an entire page chain and unions adjacent windows without hiding newer failures', () => {
  const chunk = (id, start, end, extra = {}) => ({ sync_job_id: id, start_date: start, end_date_exclusive: end, status: 'completed', page_token: '', next_page_token: null,
    created_at: '2026-09-07T12:00:00Z', completed_at: '2026-09-07T12:01:00Z', ...extra });
  const rows = [chunk('one', '2026-09-01', '2026-09-04'), chunk('two', '2026-09-04', '2026-09-08')];
  const range = { startDate: '2026-09-01', endDateExclusive: '2026-09-08' };
  assert.equal(oxygenFetchStatus(rows, range).fetchComplete, true);
  assert.equal(oxygenFetchStatus([rows[0]], range).fetchComplete, false);
  assert.equal(oxygenFetchStatus([chunk('one', '2026-09-01', '2026-09-08', { next_page_token: 'two' })], range).fetchComplete, false);
  rows.push(chunk('new', '2026-09-01', '2026-09-08', { status: 'failed', created_at: '2026-09-08T12:00:00Z' }));
  const result = oxygenFetchStatus(rows, range);
  assert.equal(result.fetchComplete, true);
  assert.equal(result.lastAttemptStatus, 'failed');
  assert.ok(result.lastSuccessfulFetchAt);
});

test('oxygen range validation rejects impossible calendars, broad night requests and malformed selectors', () => {
  for (const args of [
    ['2026-02-30', '2026-03-02'], ['2025-01-01', '2026-01-03'], ['2026-09-01', '2026-09-03', 'night'],
    ['2026-09-01', '2026-09-02', 'bogus'], ['2026-09-01', '2026-09-02', 'day', { dailySource: ['a', 'b'] }],
  ]) assert.throws(() => validateOxygenRange(...args), { status: 400 });
});

test('fall DST sleep keeps both repeated civil hours and ignores a changed profile timezone', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  await pool.query("UPDATE source_accounts SET timezone = 'Pacific/Auckland' WHERE id = $1", [account]);
  await pool.query(`INSERT INTO sleep_sessions (id, source_account_id, provider_key, civil_date, start_time, end_time,
    start_offset_seconds, end_offset_seconds, sleep_type, duration_seconds)
    VALUES ('21111111-1111-4111-8111-111111111111', $1, 'dst', '2026-11-01', '2026-11-01T04:00:00Z', '2026-11-01T08:00:00Z', -14400, -18000, 'stages', 14400)`, [account]);
  await createMetricWriter(pool).upsertOxygenSaturationSamples(account, samples({ dataPoints: [
    oxygenPoint({ id: 'first-hour', time: '2026-11-01T05:30:00Z', offset: '-14400s' }),
    oxygenPoint({ id: 'second-hour', time: '2026-11-01T06:30:00Z', offset: '-18000s' }),
  ] }));
  const day = await createOxygenRepository(pool).getDay(account, '2026-11-01');
  assert.equal(day.sampleSummary.sampleCount, 2);
  assert.equal(day.sampleSummary.sleepWindowMinuteCount, 240);
  assert.equal(day.sampleSummary.observedMinuteCount, 2);
  assert.equal(day.window.startDate, '2026-11-01');
});

test('oversized oxygen detail fails explicitly instead of silently truncating observations', async () => {
  const pool = { query: async sql => {
    if (sql.includes('FROM source_accounts')) return { rows: [{ timezone: 'America/Toronto' }] };
    if (sql.includes('FROM oxygen_saturation_samples')) return { rows: Array(50001).fill({}) };
    return { rows: [] };
  } };
  await assert.rejects(createOxygenRepository(pool).getDay(account, '2026-09-07'), { status: 413 });
});

test('reading order and newest timestamp retain nanosecond ordering within database timestamp ties', async (t) => {
  const pool = await createOxygenDatabase(); t.after(() => pool.end());
  await createMetricWriter(pool).upsertOxygenSaturationSamples(account, samples({ dataPoints: [
    oxygenPoint({ id: 'a-later', time: '2026-09-07T05:00:00.000000002Z' }),
    oxygenPoint({ id: 'z-earlier', time: '2026-09-07T05:00:00.000000001Z' }),
  ] }));
  const day = await createOxygenRepository(pool).getDay(account, '2026-09-07');
  assert.equal(day.samples[0].sampledAt, '2026-09-07T05:00:00.000000001Z');
  assert.equal(day.newestSampleAt, '2026-09-07T05:00:00.000000002Z');
});
