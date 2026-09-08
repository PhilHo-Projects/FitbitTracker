import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeOxygenSamples, buildOxygenSegments } from '../lib/metrics/oxygen-statistics.js';

const sample = (minute, percentage, id = String(minute)) => ({ providerId: id, sourceKey: 'one',
  sampledAt: new Date(Date.parse('2026-09-07T04:00:00Z') + minute * 60_000).toISOString(), percentage });
const window = { startTime: sample(0, 0).sampledAt, endTime: sample(6, 0).sampledAt };

test('oxygen statistics count actual observations and minute intersections with real gaps', () => {
  const samples = [sample(0, 98), sample(1, 96), sample(5, 94), sample(6, 0)];
  const result = summarizeOxygenSamples(samples, window);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.averagePercentage, 96);
  assert.equal(result.minimumPercentage, 94);
  assert.equal(result.maximumPercentage, 98);
  assert.equal(result.medianPercentage, 96);
  assert.equal(result.observedMinuteCount, 3);
  assert.equal(result.sleepWindowMinuteCount, 6);
  assert.equal(result.observedMinuteFraction, 0.5);
  assert.equal(result.gapCount, 1);
  assert.equal(result.longestGapSeconds, 240);
  assert.deepEqual(buildOxygenSegments(samples.slice(0, 3)).segments.map(s => s.length), [2, 1]);
  const partial = summarizeOxygenSamples([sample(0.5, 0)], { startTime: sample(0.5, 0).sampledAt, endTime: sample(1.5, 0).sampledAt });
  assert.equal(partial.sleepWindowMinuteCount, 2);
  assert.equal(partial.averagePercentage, 0);
  assert.equal(summarizeOxygenSamples([sample(0, 96)]).observedMinuteFraction, null);
  assert.equal(summarizeOxygenSamples([]).averagePercentage, null);
});

test('duplicates collapse but conflicting observations split the line and remain out of statistics', () => {
  const rows = [sample(0, 96), sample(0, 96, 'duplicate'), sample(1, 97), sample(1, 93, 'conflict'), sample(2, 98)];
  const result = summarizeOxygenSamples(rows);
  assert.equal(result.sampleCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.conflictCount, 1);
  assert.equal(result.averagePercentage, 97);
  assert.deepEqual(buildOxygenSegments(rows).segments.map(s => s.length), [1, 1]);
  assert.equal(buildOxygenSegments([sample(0, 96), sample(2, 97)]).segments.length, 1);
  assert.equal(buildOxygenSegments([sample(0, 96), sample(121 / 60, 97)]).segments.length, 2);
});

test('exact instants distinguish nanoseconds and equate physical offset representations', () => {
  const rows = [
    { ...sample(0, 97), sampledAt: '2026-09-07T04:00:00.000000001Z' },
    { ...sample(0, 96), sampledAt: '2026-09-07T04:00:00.000000002Z' },
    { ...sample(0, 97, 'same'), sampledAt: '2026-09-07T00:00:00.000000001-04:00' },
  ];
  const result = summarizeOxygenSamples(rows);
  assert.equal(result.sampleCount, 2); assert.equal(result.duplicateCount, 1);
  assert.equal(result.conflictCount, 0);
});

test('large plot reduction preserves a one-observation low and every gap', () => {
  const rows = Array.from({ length: 10000 }, (_, i) => sample(i / 60, i === 5222 ? 0 : 96));
  const plot = buildOxygenSegments(rows);
  assert.equal(plot.reduced, true);
  assert.ok(plot.segments.flat().length <= 1200);
  assert.ok(plot.segments.flat().some(({ percentage }) => percentage === 0));
  assert.equal(plot.segments[0][0], rows[0]);
  assert.equal(plot.segments[0].at(-1), rows.at(-1));
  assert.equal(summarizeOxygenSamples(rows).sampleCount, 10000);
});
