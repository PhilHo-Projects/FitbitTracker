import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSleepTrendRows,
  buildSleepLanes,
  civilDateInTimeZone,
  dateRangeForPreset,
  exportPollingNeeded,
  formatDuration,
  isLocalDevelopmentHost,
  scaleSleepTrendRows,
  sleepStageBreakdown,
  sleepTrendRange,
} from '../public/health-ui.js';

test('development indicator recognizes only loopback browser hosts', () => {
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(isLocalDevelopmentHost(hostname), true);
  }
  assert.equal(isLocalDevelopmentHost('fitbit.philippeho.dev'), false);
});

test('Today sleep summary keeps four stages in one row using the full period denominator', () => {
  const breakdown = sleepStageBreakdown(
    {
      awake: { minutes: 11 },
      light: { minutes: 202 },
      deep: { minutes: 67 },
      rem: { minutes: 68 },
    },
    348,
  );

  assert.deepEqual(
    breakdown.map(({ type, duration, percentage }) => ({ type, duration, percentage })),
    [
      { type: 'awake', duration: '11m', percentage: 3.2 },
      { type: 'light', duration: '3h 22m', percentage: 58 },
      { type: 'deep', duration: '1h 7m', percentage: 19.3 },
      { type: 'rem', duration: '1h 8m', percentage: 19.5 },
    ],
  );
});

test('sleep detail positions chronological stages in four independent lanes', () => {
  const lanes = buildSleepLanes(
    [
      {
        type: 'light',
        startTime: '2026-07-16T05:00:00Z',
        endTime: '2026-07-16T06:00:00Z',
      },
      {
        type: 'deep',
        startTime: '2026-07-16T06:00:00Z',
        endTime: '2026-07-16T06:30:00Z',
      },
    ],
    '2026-07-16T05:00:00Z',
    '2026-07-16T07:00:00Z',
  );

  assert.equal(lanes.light[0].leftPercent, 0);
  assert.equal(lanes.light[0].widthPercent, 50);
  assert.equal(lanes.deep[0].leftPercent, 50);
  assert.equal(lanes.deep[0].widthPercent, 25);
  assert.deepEqual(lanes.awake, []);
});

test('workspace presets return closed-open ranges', () => {
  assert.deepEqual(dateRangeForPreset('week', '2026-07-16'), {
    startDate: '2026-07-10',
    endDateExclusive: '2026-07-17',
  });
  assert.deepEqual(dateRangeForPreset('month', '2026-07-16'), {
    startDate: '2026-06-17',
    endDateExclusive: '2026-07-17',
  });
  assert.equal(formatDuration(null), '—');
});

test('export polling continues only while a job can still change status', () => {
  assert.equal(exportPollingNeeded([{ status: 'queued' }, { status: 'completed' }]), true);
  assert.equal(exportPollingNeeded([{ status: 'running' }]), true);
  assert.equal(exportPollingNeeded([{ status: 'completed' }, { status: 'failed' }]), false);
  assert.equal(exportPollingNeeded([]), false);
});

test('Today follows the profile civil date instead of the UTC calendar date', () => {
  const instant = new Date('2026-07-17T02:00:00.000Z');
  assert.equal(civilDateInTimeZone(instant, 'America/Toronto'), '2026-07-16');
  assert.equal(civilDateInTimeZone(instant, 'Asia/Tokyo'), '2026-07-17');
});

test('sleep trend periods use seven days, four rolling weeks, and twelve calendar months', () => {
  assert.deepEqual(sleepTrendRange('7-days', '2026-07-16'), {
    startDate: '2026-07-10',
    endDateExclusive: '2026-07-17',
  });
  assert.deepEqual(sleepTrendRange('1-month', '2026-07-16'), {
    startDate: '2026-06-19',
    endDateExclusive: '2026-07-17',
  });
  assert.deepEqual(sleepTrendRange('1-year', '2026-07-16'), {
    startDate: '2025-08-01',
    endDateExclusive: '2026-08-01',
  });
});

test('seven-day trend rows preserve missing nights instead of treating them as zero', () => {
  const rows = buildSleepTrendRows(
    [
      { date: '2026-07-10', durationMinutes: 390 },
      { date: '2026-07-12', durationMinutes: 450 },
      { date: '2026-07-16', durationMinutes: 397 },
    ],
    '7-days',
    '2026-07-16',
  );

  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map(({ label, durationMinutes, recordedNights }) => ({
      label,
      durationMinutes,
      recordedNights,
    })),
    [
      { label: 'Friday', durationMinutes: 390, recordedNights: 1 },
      { label: 'Saturday', durationMinutes: null, recordedNights: 0 },
      { label: 'Sunday', durationMinutes: 450, recordedNights: 1 },
      { label: 'Monday', durationMinutes: null, recordedNights: 0 },
      { label: 'Tuesday', durationMinutes: null, recordedNights: 0 },
      { label: 'Wednesday', durationMinutes: null, recordedNights: 0 },
      { label: 'Thursday', durationMinutes: 397, recordedNights: 1 },
    ],
  );
});

test('one-month trend averages four consecutive rolling seven-day blocks', () => {
  const rows = buildSleepTrendRows(
    [
      { date: '2026-06-19', durationMinutes: 360 },
      { date: '2026-06-20', durationMinutes: 420 },
      { date: '2026-07-03', durationMinutes: 390 },
      { date: '2026-07-04', durationMinutes: 450 },
      { date: '2026-07-10', durationMinutes: 400 },
      { date: '2026-07-16', durationMinutes: 440 },
    ],
    '1-month',
    '2026-07-16',
  );

  assert.deepEqual(
    rows.map(({ label, durationMinutes, recordedNights }) => ({
      label,
      durationMinutes,
      recordedNights,
    })),
    [
      { label: 'Week 1', durationMinutes: 390, recordedNights: 2 },
      { label: 'Week 2', durationMinutes: null, recordedNights: 0 },
      { label: 'Week 3', durationMinutes: 420, recordedNights: 2 },
      { label: 'Week 4', durationMinutes: 420, recordedNights: 2 },
    ],
  );
});

test('one-year trend averages recorded nights into twelve calendar months', () => {
  const rows = buildSleepTrendRows(
    [
      { date: '2025-08-03', durationMinutes: 360 },
      { date: '2025-08-04', durationMinutes: 420 },
      { date: '2026-06-15', durationMinutes: 405 },
      { date: '2026-07-15', durationMinutes: 435 },
    ],
    '1-year',
    '2026-07-16',
  );

  assert.equal(rows.length, 12);
  assert.deepEqual(
    rows.filter(({ recordedNights }) => recordedNights).map(
      ({ label, durationMinutes, recordedNights }) => ({
        label,
        durationMinutes,
        recordedNights,
      }),
    ),
    [
      { label: 'Aug', durationMinutes: 390, recordedNights: 2 },
      { label: 'Jun', durationMinutes: 405, recordedNights: 1 },
      { label: 'Jul', durationMinutes: 435, recordedNights: 1 },
    ],
  );
});

test('sleep trend scaling keeps a shared seven-hour marker and expands for longer sleep', () => {
  const scaled = scaleSleepTrendRows([
    { durationMinutes: 360 },
    { durationMinutes: 420 },
    { durationMinutes: 600 },
    { durationMinutes: null },
  ]);

  assert.equal(scaled.maximumMinutes, 600);
  assert.equal(scaled.targetPercent, 70);
  assert.deepEqual(
    scaled.rows.map(({ fillPercent, targetState }) => ({ fillPercent, targetState })),
    [
      { fillPercent: 60, targetState: 'below' },
      { fillPercent: 70, targetState: 'reached' },
      { fillPercent: 100, targetState: 'reached' },
      { fillPercent: 0, targetState: 'missing' },
    ],
  );
});
