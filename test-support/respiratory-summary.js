// Synthetic values; shape and incomplete collection name observed September 14, 2026.
export function respiratorySummaryPoint(day = 11, overrides = {}) {
  return {
    name: 'users/synthetic-owner/dataTypes/respiratory-rate-sleep-summary/dataPoints/',
    dataSource: { recordingMethod: 'RECORDING_METHOD_AUTOMATIC', device: { displayName: 'Synthetic wearable' }, platform: 'PLATFORM_FITBIT' },
    respiratoryRateSleepSummary: {
      sampleTime: {
        physicalTime: `2026-09-${day}T04:00:00Z`, utcOffset: '-14400s',
        civilTime: { date: { year: 2026, month: 9, day }, time: { hours: 0, minutes: 0 } },
      },
      deepSleepStats: { breathsPerMinute: 12, standardDeviation: 1, signalToNoise: -2 },
      lightSleepStats: { breathsPerMinute: 14, standardDeviation: 2, signalToNoise: 3 },
      remSleepStats: { breathsPerMinute: 16, standardDeviation: 3, signalToNoise: 4 },
      fullSleepStats: { breathsPerMinute: 14, standardDeviation: 2, signalToNoise: 3 },
    },
    ...overrides,
  };
}
