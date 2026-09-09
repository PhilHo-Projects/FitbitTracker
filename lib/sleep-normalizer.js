const MINUTE_MS = 60_000;

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundedMinutesBetween(startTime, endTime) {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 0;
  }
  return (end - start) / MINUTE_MS;
}

function roundOne(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function enumKey(value, prefix = '') {
  const normalized = String(value || '').toLowerCase();
  if (!normalized) {
    return '';
  }
  return prefix && normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function civilDateValue(civilDateTime) {
  const date = civilDateTime?.date;
  if (!date) {
    return null;
  }

  const year = finiteNumber(date.year, NaN);
  const month = finiteNumber(date.month, NaN);
  const day = finiteNumber(date.day, NaN);
  if (![year, month, day].every(Number.isInteger)) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function offsetSeconds(offset) {
  const value = String(offset || '').trim();
  if (!value.endsWith('s')) {
    return 0;
  }
  return finiteNumber(value.slice(0, -1), 0);
}

function localDateFromPhysicalTime(timestamp, utcOffset, timezone) {
  const physicalTime = Date.parse(timestamp);
  if (!Number.isFinite(physicalTime)) {
    return null;
  }
  if (!utcOffset && timezone) {
    const parts = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(physicalTime));
    const values=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${values.year}-${values.month}-${values.day}`;
  }

  const localTime = new Date(physicalTime + offsetSeconds(utcOffset) * 1000);
  return localTime.toISOString().slice(0, 10);
}

function normalizeStage(stage) {
  const type = enumKey(stage?.type, 'sleep_stage_type_');
  if (!type || type === 'unspecified') {
    return null;
  }

  return {
    type,
    startTime: stage.startTime || null,
    endTime: stage.endTime || null,
    startUtcOffset: stage.startUtcOffset || null,
    endUtcOffset: stage.endUtcOffset || null,
    durationMinutes: roundedMinutesBetween(stage.startTime, stage.endTime),
  };
}

function buildStageSummary(summaryEntries, stages) {
  const result = {};

  for (const entry of Array.isArray(summaryEntries) ? summaryEntries : []) {
    const type = enumKey(entry?.type, 'sleep_stage_type_');
    if (!type || type === 'unspecified') {
      continue;
    }
    result[type] = {
      minutes: Math.max(0, finiteNumber(entry.minutes, 0)),
      count: Math.max(0, finiteNumber(entry.count, 0)),
    };
  }

  if (Object.keys(result).length > 0) {
    return result;
  }

  for (const stage of stages) {
    result[stage.type] ??= { minutes: 0, count: 0 };
    result[stage.type].minutes += stage.durationMinutes;
    result[stage.type].count += 1;
  }

  return result;
}

function inferredAsleepMinutes(type, stageSummary) {
  if (type === 'stages') {
    return ['light', 'deep', 'rem'].reduce(
      (total, key) => total + finiteNumber(stageSummary[key]?.minutes, 0),
      0,
    );
  }
  return finiteNumber(stageSummary.asleep?.minutes, 0);
}

function normalizeSource(dataSource) {
  if (!dataSource) {
    return null;
  }

  return {
    recordingMethod: dataSource.recordingMethod || null,
    platform: dataSource.platform || null,
    device: dataSource.device
      ? {
          formFactor: dataSource.device.formFactor || null,
          manufacturer: dataSource.device.manufacturer || null,
          displayName: dataSource.device.displayName || null,
        }
      : null,
    application: dataSource.application
      ? {
          packageName: dataSource.application.packageName || null,
          webClientId: dataSource.application.webClientId || null,
          googleWebClientId: dataSource.application.googleWebClientId || null,
        }
      : null,
  };
}

function normalizeSleepPoint(point, timezone) {
  const sleep = point?.sleep;
  const interval = sleep?.interval;
  if (!sleep || !interval?.startTime || !interval?.endTime) {
    return null;
  }

  const date =
    civilDateValue(interval.civilEndTime) ||
    localDateFromPhysicalTime(interval.endTime, interval.endUtcOffset, timezone);
  if (!date) {
    return null;
  }

  const type = enumKey(sleep.type, 'sleep_type_') || 'unspecified';
  const stages = (Array.isArray(sleep.stages) ? sleep.stages : [])
    .map(normalizeStage)
    .filter(Boolean);
  const stageSummary = buildStageSummary(sleep.summary?.stagesSummary, stages);
  const durationMinutes = roundedMinutesBetween(interval.startTime, interval.endTime);
  const elapsedSummary=buildStageSummary([],stages);
  const inferenceSummary=stages.length?elapsedSummary:stageSummary;
  const minutesAsleep = finiteNumber(sleep.summary?.minutesAsleep,
    Object.keys(inferenceSummary).length ? inferredAsleepMinutes(type, inferenceSummary) : null);
  const minutesAwake = finiteNumber(sleep.summary?.minutesAwake,
    Object.keys(inferenceSummary).length ? inferenceSummary.awake?.minutes ?? 0 : null);
  const efficiency = durationMinutes > 0 && minutesAsleep !== null ? roundOne((minutesAsleep / durationMinutes) * 100) : null;
  const isNap = Boolean(sleep.metadata?.nap);

  return {
    id:
      point.dataPointName ||
      point.name ||
      sleep.metadata?.externalId ||
      `sleep-${date}-${interval.endTime}`,
    date,
    type,
    isNap,
    startTime: interval.startTime,
    endTime: interval.endTime,
    startUtcOffset: interval.startUtcOffset || null,
    endUtcOffset: interval.endUtcOffset || null,
    civilStartTime: interval.civilStartTime || null,
    civilEndTime: interval.civilEndTime || null,
    durationMinutes,
    minutesAsleep,
    minutesAwake,
    asleepDerivation:sleep.summary?.minutesAsleep != null ? 'provider-summary' : stages.length ? 'elapsed-stages' : 'provider-stage-summary',
    awakeDerivation:sleep.summary?.minutesAwake != null ? 'provider-summary' : stages.length ? 'elapsed-stages' : 'provider-stage-summary',
    minutesToFallAsleep: finiteNumber(sleep.summary?.minutesToFallAsleep, null),
    minutesAfterWakeUp: finiteNumber(sleep.summary?.minutesAfterWakeUp, null),
    outOfBedSegments: sleep.outOfBedSegments ?? [],
    sourceFields: point,
    normalizationVersion: 2,
    efficiency,
    stages,
    stageSummary,
    metadata: {
      processed: sleep.metadata?.processed ?? null,
      stagesStatus: sleep.metadata?.stagesStatus || null,
      manuallyEdited: Boolean(sleep.metadata?.manuallyEdited),
      externalId: sleep.metadata?.externalId || null,
    },
    source: normalizeSource(point.dataSource),
    createTime: sleep.createTime || null,
    updateTime: sleep.updateTime || null,
  };
}

function isWithinRange(record, startDate, endDateExclusive) {
  if (startDate && record.date < startDate) {
    return false;
  }
  if (endDateExclusive && record.date >= endDateExclusive) {
    return false;
  }
  return true;
}

function recencySort(left, right) {
  return (
    right.date.localeCompare(left.date) ||
    Date.parse(right.endTime) - Date.parse(left.endTime) ||
    right.durationMinutes - left.durationMinutes
  );
}

function preferredRecord(current, candidate) {
  if (!current) {
    return candidate;
  }
  if (candidate.durationMinutes !== current.durationMinutes) {
    return candidate.durationMinutes > current.durationMinutes ? candidate : current;
  }
  if (candidate.type !== current.type) {
    return candidate.type === 'stages' ? candidate : current;
  }
  return Date.parse(candidate.updateTime || candidate.endTime) >
    Date.parse(current.updateTime || current.endTime)
    ? candidate
    : current;
}

function average(records, field, precision = 0) {
  if (records.length === 0) {
    return 0;
  }
  const value = records.reduce((total, record) => total + finiteNumber(record[field], 0), 0) /
    records.length;
  return precision === 1 ? roundOne(value) : Math.round(value);
}

function averageStageMinutes(nights) {
  const stageTotals = new Map();

  for (const night of nights) {
    for (const [type, summary] of Object.entries(night.stageSummary)) {
      const current = stageTotals.get(type) || { total: 0, count: 0 };
      current.total += finiteNumber(summary.minutes, 0);
      current.count += 1;
      stageTotals.set(type, current);
    }
  }

  return Object.fromEntries(
    [...stageTotals.entries()].map(([type, value]) => [
      type,
      value.count > 0 ? Math.round(value.total / value.count) : 0,
    ]),
  );
}

export function normalizeSleepResponse({
  dataPoints = [],
  startDate = null,
  endDateExclusive = null,
  generatedAt = new Date().toISOString(),
  timezone = null,
} = {}) {
  const normalized = (Array.isArray(dataPoints) ? dataPoints : [])
    .map(point=>normalizeSleepPoint(point,timezone))
    .filter(Boolean)
    .filter((record) => isWithinRange(record, startDate, endDateExclusive));

  const naps = normalized.filter((record) => record.isNap).sort(recencySort);
  const mainByDate = new Map();

  for (const record of normalized.filter((item) => !item.isNap)) {
    mainByDate.set(record.date, preferredRecord(mainByDate.get(record.date), record));
  }

  const nights = [...mainByDate.values()].sort(recencySort);

  return {
    sessions: normalized,
    latest: nights[0] || null,
    nights,
    naps,
    summary: {
      nightsCount: nights.length,
      napsCount: naps.length,
      averageDurationMinutes: average(nights, 'durationMinutes'),
      averageMinutesAsleep: average(nights, 'minutesAsleep'),
      averageMinutesAwake: average(nights, 'minutesAwake'),
      averageEfficiency: average(nights, 'efficiency', 1),
      averageStageMinutes: averageStageMinutes(nights),
    },
    range: {
      startDate,
      endDateExclusive,
    },
    generatedAt,
  };
}
