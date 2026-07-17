export const GOOGLE_HEALTH_METRICS = [
  'sleep',
  'heart-rate',
  'daily-resting-heart-rate',
  'total-calories',
  'active-energy-burned',
  'basal-energy-burned',
];

const WINDOW_DAYS = {
  'heart-rate': 14,
  'total-calories': 14,
  sleep: 90,
  'daily-resting-heart-rate': 90,
  'active-energy-burned': 90,
  'basal-energy-burned': 90,
};

const OPERATIONS = {
  sleep: 'reconcile',
  'heart-rate': 'list',
  'daily-resting-heart-rate': 'list',
  'total-calories': 'dailyRollup',
  'active-energy-burned': 'list',
  'basal-energy-burned': 'list',
};

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(startDate, endDateExclusive) {
  return Math.round(
    (Date.parse(`${endDateExclusive}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) /
      86_400_000,
  );
}

export function planMetricWindows({ metric, startDate, endDateExclusive }) {
  if (!GOOGLE_HEALTH_METRICS.includes(metric)) throw new Error(`Unsupported metric: ${metric}`);
  if (startDate >= endDateExclusive) return [];
  const maximumDays = WINDOW_DAYS[metric];
  const windows = [];
  let cursorEnd = endDateExclusive;

  while (cursorEnd > startDate) {
    const candidateStart = shiftDate(cursorEnd, -maximumDays);
    const windowStart = candidateStart < startDate ? startDate : candidateStart;
    windows.push({
      metric,
      operation: OPERATIONS[metric],
      startDate: windowStart,
      endDateExclusive: cursorEnd,
      pageToken: null,
      days: daysBetween(windowStart, cursorEnd),
    });
    cursorEnd = windowStart;
  }

  return windows;
}

export function planSyncChunks({ metrics = GOOGLE_HEALTH_METRICS, startDate, endDateExclusive }) {
  const metricOrder = new Map(metrics.map((metric, index) => [metric, index]));
  return metrics
    .flatMap((metric) => planMetricWindows({ metric, startDate, endDateExclusive }))
    .sort(
      (left, right) =>
        right.endDateExclusive.localeCompare(left.endDateExclusive) ||
        metricOrder.get(left.metric) - metricOrder.get(right.metric),
    );
}

export function recentRange(endDateExclusive, days = 7) {
  return { startDate: shiftDate(endDateExclusive, -days), endDateExclusive };
}
