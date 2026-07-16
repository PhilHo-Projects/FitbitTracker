function roundOne(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function formatDuration(minutes) {
  const value = asFiniteNumber(minutes);
  if (value === null || value < 0) {
    return '—';
  }

  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (hours === 0) {
    return `${remainder}m`;
  }
  if (remainder === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainder}m`;
}

export function stagePercentages(stageSummary = {}, durationMinutes = 0) {
  const duration = asFiniteNumber(durationMinutes);
  if (!duration || duration <= 0) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(stageSummary).map(([type, summary]) => {
      const minutes = Math.max(0, asFiniteNumber(summary?.minutes) || 0);
      return [type, roundOne((minutes / duration) * 100)];
    }),
  );
}

export function buildTimelineSegments(stages = []) {
  const normalized = (Array.isArray(stages) ? stages : [])
    .map((stage) => {
      const explicitMinutes = asFiniteNumber(stage?.durationMinutes);
      const start = Date.parse(stage?.startTime);
      const end = Date.parse(stage?.endTime);
      const inferredMinutes =
        Number.isFinite(start) && Number.isFinite(end) && end >= start
          ? Math.round((end - start) / 60_000)
          : 0;

      return {
        ...stage,
        type: String(stage?.type || 'unspecified').toLowerCase(),
        durationMinutes: Math.max(0, explicitMinutes ?? inferredMinutes),
      };
    })
    .filter((stage) => stage.durationMinutes > 0);

  const totalMinutes = normalized.reduce((total, stage) => total + stage.durationMinutes, 0);
  if (totalMinutes <= 0) {
    return [];
  }

  return normalized.map((stage) => ({
    ...stage,
    widthPercent: roundOne((stage.durationMinutes / totalMinutes) * 100),
  }));
}

export function scaleWeekDurations(nights = []) {
  const normalized = (Array.isArray(nights) ? nights : []).map((night) => ({
    date: night.date,
    durationMinutes: Math.max(0, asFiniteNumber(night.durationMinutes) || 0),
  }));
  const maximum = Math.max(0, ...normalized.map((night) => night.durationMinutes));
  if (maximum <= 0) {
    return normalized.map((night) => ({ ...night, heightPercent: 0 }));
  }

  return normalized.map((night) => ({
    ...night,
    heightPercent: roundOne((night.durationMinutes / maximum) * 100),
  }));
}
