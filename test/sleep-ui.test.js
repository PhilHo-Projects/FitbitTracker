import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTimelineSegments,
  formatDuration,
  scaleWeekDurations,
  stagePercentages,
} from '../public/sleep-ui.js';

test('formats sleep durations for dashboard metrics', () => {
  assert.equal(formatDuration(450), '7h 30m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(null), '—');
});

test('calculates stage percentages against the sleep period', () => {
  assert.deepEqual(
    stagePercentages(
      {
        awake: { minutes: 30 },
        light: { minutes: 240 },
        deep: { minutes: 90 },
        rem: { minutes: 120 },
      },
      480,
    ),
    {
      awake: 6.3,
      light: 50,
      deep: 18.8,
      rem: 25,
    },
  );
});

test('builds proportional timeline segments from staged sleep', () => {
  const segments = buildTimelineSegments([
    {
      type: 'awake',
      startTime: '2026-07-16T02:00:00Z',
      endTime: '2026-07-16T02:30:00Z',
      durationMinutes: 30,
    },
    {
      type: 'deep',
      startTime: '2026-07-16T02:30:00Z',
      endTime: '2026-07-16T04:00:00Z',
      durationMinutes: 90,
    },
  ]);

  assert.equal(segments.length, 2);
  assert.equal(segments[0].widthPercent, 25);
  assert.equal(segments[1].widthPercent, 75);
});

test('scales week bars relative to the longest night', () => {
  assert.deepEqual(
    scaleWeekDurations([
      { date: '2026-07-14', durationMinutes: 360 },
      { date: '2026-07-15', durationMinutes: 480 },
      { date: '2026-07-16', durationMinutes: 420 },
    ]),
    [
      { date: '2026-07-14', durationMinutes: 360, heightPercent: 75 },
      { date: '2026-07-15', durationMinutes: 480, heightPercent: 100 },
      { date: '2026-07-16', durationMinutes: 420, heightPercent: 87.5 },
    ],
  );
  assert.deepEqual(scaleWeekDurations([]), []);
});
