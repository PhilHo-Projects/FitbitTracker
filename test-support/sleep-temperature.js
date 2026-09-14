// Synthetic values with the optional ProtoJSON NaN fields observed during recovery.
export const sleepTemperaturePoint = () => ({
  dataSource: { device: { displayName: 'Synthetic wearable' }, platform: 'PLATFORM_FITBIT' },
  dailySleepTemperatureDerivations: {
    date: { year: 2026, month: 6, day: 24 },
    nightlyTemperatureCelsius: 33.25,
    baselineTemperatureCelsius: 'NaN',
    relativeNightlyStddev30dCelsius: 'NaN',
  },
});
