import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSleepResponse } from '../lib/sleep-normalizer.js';

export function sleepPoint(id = 'main', overrides = {}) {
  return { name: id, dataSource: { device: { displayName: 'Air' } }, sleep: {
    interval: { startTime: '2026-09-08T03:00:00Z', endTime: '2026-09-08T10:20:00Z', startUtcOffset: '-14400s', endUtcOffset: '-14400s' },
    type: 'STAGES', metadata: { processed: true },
    summary: { minutesInSleepPeriod: '440', minutesAsleep: '390', minutesAwake: '50' },
    outOfBedSegments: [{ startTime: '2026-09-08T07:00:00Z', endTime: '2026-09-08T07:05:00Z' }],
    ...overrides,
  } };
}

test('preserves every session and original source; missing latency is not explicit zero', () => {
  const original = sleepPoint();
  const second = sleepPoint('second', { summary: { minutesInSleepPeriod: '60', minutesAsleep: '50', minutesToFallAsleep: '0' } });
  const result = normalizeSleepResponse({ dataPoints: [original, second] });
  assert.equal(result.sessions?.length, 2);
  assert.deepEqual(result.sessions[0].sourceFields, original);
  assert.deepEqual(result.sessions[0].outOfBedSegments, original.sleep.outOfBedSegments);
  assert.equal(result.sessions[0].minutesToFallAsleep, null);
  assert.equal(result.sessions[1].minutesToFallAsleep, 0);
});

test('subminute stages retain elapsed duration before display rounding', () => {
  const result = normalizeSleepResponse({ dataPoints: [sleepPoint('fraction', {
    summary: {}, stages: [{ type: 'LIGHT', startTime: '2026-09-08T03:00:00Z', endTime: '2026-09-08T03:00:30Z' }],
  })] });
  assert.equal(result.latest.stages[0].durationMinutes, 0.5);
});
