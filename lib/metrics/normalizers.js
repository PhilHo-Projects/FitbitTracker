import crypto from 'node:crypto';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function offsetSeconds(value) {
  const text = String(value ?? '').trim();
  const parsed = Number(text.endsWith('s') ? text.slice(0, -1) : text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function civilDate(timestamp, offset) {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return null;
  return new Date(time + offsetSeconds(offset) * 1000).toISOString().slice(0, 10);
}

function civilDateObject(value) {
  if (typeof value === 'string') return value.slice(0, 10);
  if (!value || !Number.isInteger(Number(value.year))) return null;
  return `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function points(payload) {
  if (Array.isArray(payload?.dataPoints)) return payload.dataPoints;
  if (Array.isArray(payload?.data?.dataPoints)) return payload.data.dataPoints;
  if (Array.isArray(payload?.rollupDataPoints)) return payload.rollupDataPoints;
  if (Array.isArray(payload?.data?.rollupDataPoints)) return payload.data.rollupDataPoints;
  return [];
}

export function normalizeHeartRateSamples(payload) {
  const normalized = new Map();
  for (const point of points(payload)) {
    const samples =
      point.heartRate?.samples ??
      point.samples ??
      (point.heartRate?.sampleTime ? [point.heartRate] : []);
    for (const sample of samples) {
      const sampleTime = sample.sampleTime;
      const sampledAt =
        sampleTime?.physicalTime ??
        sampleTime ??
        sample.time ??
        sample.timestamp;
      const beatsPerMinute = numberOrNull(
        sample.beatsPerMinute ?? sample.bpm ?? sample.value?.beatsPerMinute ?? sample.value,
      );
      if (!sampledAt || beatsPerMinute === null || beatsPerMinute <= 0) continue;
      const utcOffset =
        sampleTime?.utcOffset ??
        sample.utcOffset ??
        point.heartRate?.interval?.startUtcOffset ??
        null;
      const providerId = point.dataPointName ?? point.name ?? null;
      const providerKey = providerId
        ? `${providerId}:${sampledAt}`
        : hash(`heart:${sampledAt}:${beatsPerMinute}`);
      normalized.set(providerKey, {
        providerKey,
        providerId,
        civilDate: civilDate(sampledAt, utcOffset),
        sampledAt,
        utcOffsetSeconds: offsetSeconds(utcOffset),
        beatsPerMinute,
        device: point.dataSource?.device ?? {},
        sourceFields: point,
      });
    }
  }
  return [...normalized.values()].filter(({ civilDate: date }) => Boolean(date));
}

export function normalizeDailyRestingHeartRate(payload) {
  const normalized = [];
  for (const point of points(payload)) {
    const value =
      point.dailyRestingHeartRate ??
      point.restingHeartRate ??
      point.heartRate?.dailyRestingHeartRate ??
      point.heartRate;
    const restingBpm = numberOrNull(
      value?.beatsPerMinute ?? value?.restingBeatsPerMinute ?? value?.value,
    );
    const dateValue =
      value?.date ??
      value?.civilDate ??
      point.date ??
      civilDate(value?.interval?.startTime, value?.interval?.startUtcOffset);
    const date = civilDateObject(dateValue);
    if (!date || restingBpm === null || restingBpm <= 0) continue;
    normalized.push({
      civilDate: date,
      restingBpm,
      providerId: point.dataPointName ?? point.name ?? null,
      sourceFields: point,
    });
  }
  return normalized;
}

const calorieProperty = {
  total: 'totalCalories',
  active: 'activeEnergyBurned',
  basal: 'basalEnergyBurned',
};

export function normalizeCalorieIntervals(payload, metricType) {
  if (!calorieProperty[metricType]) throw new Error(`Unsupported calorie metric: ${metricType}`);
  const normalized = new Map();
  for (const point of points(payload)) {
    const value = point[calorieProperty[metricType]] ?? point.energy ?? point.calories ?? point;
    const interval = value.interval ?? point.interval;
    const rollupStartDate = civilDateObject(point.civilStartTime?.date);
    const rollupEndDate = civilDateObject(point.civilEndTime?.date);
    const startTime =
      interval?.startTime ??
      value.startTime ??
      (rollupStartDate ? `${rollupStartDate}T00:00:00Z` : null);
    const endTime =
      interval?.endTime ??
      value.endTime ??
      (rollupEndDate ? `${rollupEndDate}T00:00:00Z` : null);
    const kilocalories = numberOrNull(
      value.kcal ??
        value.kcalSum ??
        value.kilocalories ??
        value.energy?.kcal ??
        value.energy?.kilocalories ??
        value.value?.kcal ??
        value.value?.kilocalories ??
        value.value,
    );
    if (!startTime || !endTime || kilocalories === null || kilocalories < 0) continue;
    const utcOffset = interval?.startUtcOffset ?? interval?.utcOffset ?? null;
    const providerId = point.dataPointName ?? point.name ?? null;
    const providerKey = providerId
      ? `${providerId}:${metricType}:${startTime}`
      : hash(`calorie:${metricType}:${startTime}:${endTime}`);
    normalized.set(providerKey, {
      providerKey,
      providerId,
      civilDate: rollupStartDate ?? civilDate(startTime, utcOffset),
      metricType,
      startTime,
      endTime,
      utcOffsetSeconds: offsetSeconds(utcOffset),
      kilocalories,
      device: point.dataSource?.device ?? {},
      sourceFields: point,
    });
  }
  return [...normalized.values()].filter(({ civilDate: date }) => Boolean(date));
}
