import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSleepResponse } from '../lib/sleep-normalizer.js';

function civilDateTime(year, month, day, hours = 7, minutes = 0) {
  return {
    date: { year, month, day },
    time: { hours, minutes },
  };
}

function sleepPoint({
  id,
  startTime,
  endTime,
  civilEndTime,
  endUtcOffset = '-14400s',
  type = 'STAGES',
  nap = false,
  duration = 480,
  asleep = 450,
  awake = 30,
  stageSummary = [],
  stages = [],
  device = 'Pixel Watch 3',
}) {
  return {
    dataPointName: id,
    dataSource: {
      recordingMethod: 'PASSIVELY_MEASURED',
      platform: 'FITBIT',
      device: {
        formFactor: 'WATCH',
        manufacturer: 'Google',
        displayName: device,
      },
    },
    sleep: {
      interval: {
        startTime,
        startUtcOffset: endUtcOffset,
        endTime,
        endUtcOffset,
        ...(civilEndTime ? { civilEndTime } : {}),
      },
      type,
      stages,
      metadata: {
        nap,
        processed: true,
        stagesStatus: type === 'STAGES' ? 'SUCCEEDED' : 'REJECTED_COVERAGE',
      },
      summary: {
        minutesInSleepPeriod: String(duration),
        minutesAsleep: String(asleep),
        minutesAwake: String(awake),
        minutesToFallAsleep: '8',
        minutesAfterWakeUp: '4',
        stagesSummary: stageSummary,
      },
    },
  };
}

const stagedNight = sleepPoint({
  id: 'sleep-staged',
  startTime: '2026-07-16T02:50:00Z',
  endTime: '2026-07-16T10:50:00Z',
  civilEndTime: civilDateTime(2026, 7, 16, 6, 50),
  stageSummary: [
    { type: 'AWAKE', minutes: '30', count: '12' },
    { type: 'LIGHT', minutes: '250', count: '18' },
    { type: 'DEEP', minutes: '90', count: '5' },
    { type: 'REM', minutes: '110', count: '6' },
  ],
  stages: [
    {
      startTime: '2026-07-16T02:50:00Z',
      endTime: '2026-07-16T03:10:00Z',
      startUtcOffset: '-14400s',
      endUtcOffset: '-14400s',
      type: 'AWAKE',
    },
    {
      startTime: '2026-07-16T03:10:00Z',
      endTime: '2026-07-16T04:40:00Z',
      startUtcOffset: '-14400s',
      endUtcOffset: '-14400s',
      type: 'DEEP',
    },
  ],
});

test('normalizes staged sleep into numeric metrics and lower-case stages', () => {
  const result = normalizeSleepResponse({
    dataPoints: [stagedNight],
    startDate: '2026-07-10',
    endDateExclusive: '2026-07-17',
    generatedAt: '2026-07-16T12:00:00Z',
  });

  assert.equal(result.latest.date, '2026-07-16');
  assert.equal(result.latest.durationMinutes, 480);
  assert.equal(result.latest.minutesAsleep, 450);
  assert.equal(result.latest.efficiency, 93.8);
  assert.deepEqual(result.latest.stageSummary.light, { minutes: 250, count: 18 });
  assert.equal(result.latest.stages[0].type, 'awake');
  assert.equal(result.latest.stages[0].durationMinutes, 20);
  assert.equal(result.latest.source.device.displayName, 'Pixel Watch 3');
  assert.equal(result.summary.averageDurationMinutes, 480);
  assert.equal(result.summary.averageStageMinutes.rem, 110);
});

test('keeps classic sleep valid without requiring modern stage names', () => {
  const classic = sleepPoint({
    id: 'sleep-classic',
    startTime: '2026-07-15T03:00:00Z',
    endTime: '2026-07-15T10:00:00Z',
    civilEndTime: civilDateTime(2026, 7, 15, 6, 0),
    type: 'CLASSIC',
    duration: 420,
    asleep: 380,
    awake: 25,
    stageSummary: [
      { type: 'AWAKE', minutes: '25', count: '7' },
      { type: 'RESTLESS', minutes: '15', count: '9' },
      { type: 'ASLEEP', minutes: '380', count: '10' },
    ],
  });

  const result = normalizeSleepResponse({ dataPoints: [classic] });

  assert.equal(result.latest.type, 'classic');
  assert.deepEqual(result.latest.stageSummary.asleep, { minutes: 380, count: 10 });
  assert.equal(result.latest.stageSummary.deep, undefined);
  assert.equal(result.latest.efficiency, 90.5);
});

test('selects the longest non-nap sleep per date and separates naps', () => {
  const shortDuplicate = sleepPoint({
    id: 'short-record',
    startTime: '2026-07-16T05:00:00Z',
    endTime: '2026-07-16T10:00:00Z',
    civilEndTime: civilDateTime(2026, 7, 16, 6, 0),
    duration: 300,
    asleep: 270,
  });
  const nap = sleepPoint({
    id: 'afternoon-nap',
    startTime: '2026-07-15T18:00:00Z',
    endTime: '2026-07-15T18:45:00Z',
    civilEndTime: civilDateTime(2026, 7, 15, 14, 45),
    type: 'CLASSIC',
    nap: true,
    duration: 45,
    asleep: 40,
    awake: 5,
  });

  const result = normalizeSleepResponse({
    dataPoints: [shortDuplicate, nap, stagedNight],
  });

  assert.equal(result.nights.length, 1);
  assert.equal(result.nights[0].id, 'sleep-staged');
  assert.equal(result.naps.length, 1);
  assert.equal(result.naps[0].id, 'afternoon-nap');
  assert.equal(result.summary.nightsCount, 1);
  assert.equal(result.summary.napsCount, 1);
});

test('derives the local sleep date from end time and UTC offset when civil time is absent', () => {
  const timezoneOnly = sleepPoint({
    id: 'timezone-record',
    startTime: '2026-07-15T15:30:00Z',
    endTime: '2026-07-15T23:30:00Z',
    endUtcOffset: '7200s',
  });

  const result = normalizeSleepResponse({ dataPoints: [timezoneOnly] });

  assert.equal(result.latest.date, '2026-07-16');
});

test('returns a stable empty contract for missing data', () => {
  const result = normalizeSleepResponse({
    dataPoints: [],
    startDate: '2026-07-10',
    endDateExclusive: '2026-07-17',
    generatedAt: '2026-07-16T12:00:00Z',
  });

  assert.deepEqual(result, {
    latest: null,
    nights: [],
    naps: [],
    summary: {
      nightsCount: 0,
      napsCount: 0,
      averageDurationMinutes: 0,
      averageMinutesAsleep: 0,
      averageMinutesAwake: 0,
      averageEfficiency: 0,
      averageStageMinutes: {},
    },
    range: {
      startDate: '2026-07-10',
      endDateExclusive: '2026-07-17',
    },
    generatedAt: '2026-07-16T12:00:00Z',
  });
});
