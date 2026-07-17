function valueAt(row, column) {
  return typeof column.value === 'function' ? column.value(row) : row[column.key];
}

function serialize(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeCell(value) {
  const serialized = serialize(value);
  if (!/[",\r\n]/.test(serialized)) return serialized;
  return `"${serialized.replaceAll('"', '""')}"`;
}

export function toCsv(rows, columns) {
  const lines = [
    columns.map((column) => escapeCell(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => escapeCell(valueAt(row, column))).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

export async function* toCsvStream(rows, columns) {
  yield `${columns.map((column) => escapeCell(column.label)).join(',')}\r\n`;
  for await (const row of rows) {
    yield `${columns.map((column) => escapeCell(valueAt(row, column))).join(',')}\r\n`;
  }
}

export const EXPORT_COLUMNS = {
  'daily-summary.csv': [
    { key: 'date', label: 'date', description: 'Civil date in the profile timezone.' },
    { key: 'sleepDurationMinutes', label: 'sleep_duration_minutes', unit: 'minutes' },
    { key: 'sleepAsleepMinutes', label: 'sleep_asleep_minutes', unit: 'minutes' },
    { key: 'sleepAwakeMinutes', label: 'sleep_awake_minutes', unit: 'minutes' },
    { key: 'sleepEfficiencyPercent', label: 'sleep_efficiency_percent', unit: 'percent' },
    { key: 'heartRestingBpm', label: 'heart_resting_bpm', unit: 'bpm' },
    { key: 'heartAverageBpm', label: 'heart_average_bpm', unit: 'bpm' },
    { key: 'heartMinimumBpm', label: 'heart_minimum_bpm', unit: 'bpm' },
    { key: 'heartMaximumBpm', label: 'heart_maximum_bpm', unit: 'bpm' },
    { key: 'heartSampleCount', label: 'heart_sample_count', unit: 'samples' },
    { key: 'calorieTotalKcal', label: 'calorie_total_kcal', unit: 'kcal' },
    { key: 'calorieActiveKcal', label: 'calorie_active_kcal', unit: 'kcal' },
    { key: 'calorieBasalKcal', label: 'calorie_basal_kcal', unit: 'kcal' },
    { key: 'coverage', label: 'coverage', description: 'JSON coverage state by metric.' },
    { key: 'derivations', label: 'derivations', description: 'JSON derivation flags.' },
  ],
  'sleep-sessions.csv': [
    { key: 'providerKey', label: 'provider_key' },
    { key: 'providerId', label: 'provider_id' },
    { key: 'civilDate', label: 'civil_date' },
    { key: 'startTime', label: 'start_time_utc' },
    { key: 'endTime', label: 'end_time_utc' },
    { key: 'startOffsetSeconds', label: 'start_utc_offset_seconds', unit: 'seconds' },
    { key: 'endOffsetSeconds', label: 'end_utc_offset_seconds', unit: 'seconds' },
    { key: 'sleepType', label: 'sleep_type' },
    { key: 'isNap', label: 'is_nap' },
    { key: 'durationSeconds', label: 'duration_seconds', unit: 'seconds' },
    { key: 'asleepSeconds', label: 'asleep_seconds', unit: 'seconds' },
    { key: 'awakeSeconds', label: 'awake_seconds', unit: 'seconds' },
    { key: 'efficiencyPercent', label: 'efficiency_percent', unit: 'percent' },
    { key: 'timeToSleepSeconds', label: 'time_to_sleep_seconds', unit: 'seconds' },
    { key: 'awakeEpisodes', label: 'awake_episodes', unit: 'episodes' },
    { key: 'device', label: 'device' },
    { key: 'sourceFields', label: 'source_fields' },
  ],
  'sleep-stages.csv': [
    { key: 'sessionProviderKey', label: 'session_provider_key' },
    { key: 'civilDate', label: 'civil_date' },
    { key: 'providerKey', label: 'provider_key' },
    { key: 'sequence', label: 'sequence' },
    { key: 'stageType', label: 'stage_type' },
    { key: 'startTime', label: 'start_time_utc' },
    { key: 'endTime', label: 'end_time_utc' },
    { key: 'durationSeconds', label: 'duration_seconds', unit: 'seconds' },
    { key: 'sourceFields', label: 'source_fields' },
  ],
  'heart-rate-samples.csv': [
    { key: 'providerKey', label: 'provider_key' },
    { key: 'providerId', label: 'provider_id' },
    { key: 'civilDate', label: 'civil_date' },
    { key: 'sampledAt', label: 'sampled_at_utc' },
    { key: 'utcOffsetSeconds', label: 'utc_offset_seconds', unit: 'seconds' },
    { key: 'beatsPerMinute', label: 'beats_per_minute', unit: 'bpm' },
    { key: 'device', label: 'device' },
    { key: 'sourceFields', label: 'source_fields' },
  ],
  'calorie-intervals.csv': [
    { key: 'providerKey', label: 'provider_key' },
    { key: 'providerId', label: 'provider_id' },
    { key: 'civilDate', label: 'civil_date' },
    { key: 'metricType', label: 'metric_type' },
    { key: 'startTime', label: 'start_time_utc' },
    { key: 'endTime', label: 'end_time_utc' },
    { key: 'utcOffsetSeconds', label: 'utc_offset_seconds', unit: 'seconds' },
    { key: 'kilocalories', label: 'kilocalories', unit: 'kcal' },
    { key: 'device', label: 'device' },
    { key: 'sourceFields', label: 'source_fields' },
  ],
};

export function columnDefinitions() {
  return Object.fromEntries(
    Object.entries(EXPORT_COLUMNS).map(([file, columns]) => [
      file,
      columns.map(({ label: name, unit = null, description = null }) => ({
        name,
        unit,
        description,
      })),
    ]),
  );
}
