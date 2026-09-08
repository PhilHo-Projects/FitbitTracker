import assert from 'node:assert/strict';
import test from 'node:test';
import { oxygenPoint, oxygenDailyPoint } from '../test-support/oxygen.js';
import { normalizeOxygenSaturationSamples as samples,
  normalizeDailyOxygenSaturation as daily } from '../lib/metrics/oxygen-normalizer.js';
import { oxygenInstantNanoseconds, parseOxygenTime } from '../lib/metrics/oxygen-time.js';

test('explicit civil timestamps must agree with physical time including protobuf midnight defaults', () => {
  const time = { physicalTime: '2026-09-07T04:00:01.123456789Z', utcOffset: '-14400s',
    civilTime: { date: { year: 2026, month: 9, day: 7 }, time: { seconds: 1, nanos: 123456789 } } };
  assert.equal(parseOxygenTime(time).civilDate, '2026-09-07');
  assert.throws(() => parseOxygenTime({ ...time, civilTime: { date: time.civilTime.date } }), { code: 'OXYGEN_CONTRACT_INVALID' });
  assert.throws(() => parseOxygenTime({ ...time, civilTime: { date: time.civilTime.date, time: [] } }), { code: 'OXYGEN_CONTRACT_INVALID' });
  assert.equal(parseOxygenTime({ ...time, physicalTime: '2026-09-07T04:00:00Z', civilTime: { date: time.civilTime.date } }).civilDate, '2026-09-07');
});

test('oxygen identity survives value/time corrections and retains precise original fields', () => {
  const point = oxygenPoint();
  const [first] = samples({ dataPoints: [point, structuredClone(point)] });
  const [corrected] = samples({ dataPoints: [oxygenPoint({ percentage: 97.12345,
    time: '2026-09-07T04:00:00.123456789Z' })] });
  assert.equal(first.providerKey, point.name);
  assert.equal(corrected.providerKey, first.providerKey);
  assert.equal(corrected.percentage, 97.12345);
  assert.equal(corrected.sampledAt, '2026-09-07T04:00:00.123456789Z');
  assert.equal(first.civilDate, '2026-09-06');
  assert.equal(first.utcOffsetSeconds, -14400);
  assert.deepEqual(first.sourceFields, point);
  assert.match(first.sourceKey, /^[a-f0-9]{64}$/);
  assert.equal(samples({ dataPoints: [point, structuredClone(point)] }).length, 1);
  assert.throws(() => samples({ dataPoints: [point, oxygenPoint({ percentage: 95 })] }), /invalid oxygen/);
});

test('daily confidence bounds and historical deviation are not sample extrema', () => {
  const [summary] = daily({ dataPoints: [oxygenDailyPoint()] });
  assert.equal(summary.lowerBoundPercentage, 93.125);
  assert.equal(summary.upperBoundPercentage, 98.75);
  assert.equal(summary.standardDeviationPercentage, 0.7);
  assert.equal(Object.hasOwn(summary, 'minimumPercentage'), false);
  const missing = oxygenDailyPoint();
  delete missing.dailyOxygenSaturation.lowerBoundPercentage;
  delete missing.dailyOxygenSaturation.upperBoundPercentage;
  delete missing.dailyOxygenSaturation.standardDeviationPercentage;
  assert.deepEqual(daily({ dataPoints: [missing] })[0].qualityFlags, ['bounds-missing']);
  assert.equal(daily({ dataPoints: [missing] })[0].standardDeviationPercentage, null);
});

test('valid zero, 100, empty protobuf responses and continuation pages are preserved', () => {
  for (const percentage of [0, 100, 97.123456]) {
    assert.equal(samples({ dataPoints: [oxygenPoint({ percentage })] })[0].percentage, percentage);
  }
  assert.deepEqual(samples({}), []);
  assert.deepEqual(samples({ nextPageToken: 'next' }), []);
  assert.deepEqual(samples({ dataPoints: [], nextPageToken: 'next' }), []);
  assert.equal(daily({ dataPoints: [oxygenDailyPoint({ average: 0, lower: 0, upper: 0 })] })[0].averagePercentage, 0);
});

test('invalid nonempty oxygen responses fail safely instead of becoming empty success', () => {
  const nameless = oxygenPoint(); delete nameless.name;
  const invalidCivil = oxygenPoint();
  invalidCivil.oxygenSaturation.sampleTime.civilTime = { year: 2026, month: 9, day: 7 };
  const invalid = [undefined, null, [], { result: [] }, { error: { message: 'PRIVATE' } },
    { dataPoints: {} }, { dataPoints: [], nextPageToken: 8 },
    ...[true, '', null, NaN, Infinity, -1, 101, '96.2'].map(percentage => ({ dataPoints: [oxygenPoint({ percentage })] })),
    ...['', null, 'bad', '86401s'].map(offset => ({ dataPoints: [oxygenPoint({ offset })] })),
    { dataPoints: [nameless] }, { dataPoints: [oxygenDailyPoint()] }, { dataPoints: [invalidCivil] },
  ];
  for (const payload of invalid) {
    assert.throws(() => samples(payload), e => e.code === 'OXYGEN_CONTRACT_INVALID'
      && e.transient === false && !e.message.includes('PRIVATE'));
  }
  for (const point of [oxygenDailyPoint({ date: { year: 2026, month: 2, day: 30 } }),
    oxygenDailyPoint({ lower: 99, upper: 90 }), oxygenDailyPoint({ sd: -1 }),
    oxygenDailyPoint({ average: null }), oxygenDailyPoint({ lower: '94' })]) {
    assert.throws(() => daily({ dataPoints: [point] }), /invalid oxygen/);
  }
});

test('oxygen timestamps preserve nanoseconds, offsets, DST, and exact midnight', () => {
  assert.equal(oxygenInstantNanoseconds('2026-09-07T04:00:00Z'),
    oxygenInstantNanoseconds('2026-09-07T00:00:00-04:00'));
  assert.equal(oxygenInstantNanoseconds('2026-09-07T00:00:00Z')
    - oxygenInstantNanoseconds('2026-09-06T23:59:59.999999999Z'), 1n);
  for (const [physicalTime, utcOffset, date] of [
    ['2026-09-06T23:59:59.999999999Z', '0s', '2026-09-06'],
    ['2026-09-07T03:59:59.999999999Z', '-14400s', '2026-09-06'],
    ['2026-09-07T04:00:00Z', '-14400s', '2026-09-07'],
    ['2026-11-01T05:30:00Z', '-14400s', '2026-11-01'],
    ['2026-11-01T06:30:00Z', '-18000s', '2026-11-01'],
    ['1969-12-31T23:59:59.999999999Z', '0s', '1969-12-31'],
  ]) assert.equal(parseOxygenTime({ physicalTime, utcOffset }).civilDate, date);
  for (const value of ['2026-02-30T01:00:00Z', '2026-09-07T24:00:00Z', '2026-09-07',
    '2026-09-07T00:00:00', 'PRIVATE', '2026-09-07T00:00:00+25:00']) {
    assert.throws(() => oxygenInstantNanoseconds(value), /invalid oxygen/);
  }
});
