const DAY_MS = 86_400_000;

export function validMetricDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// Details are for inspecting a night/day or a short comparison. Longer views use
// permanent daily summaries; full-resolution history remains available via exports.
export function validateMetricRange(start, end, resolution = 'day') {
  if (!validMetricDate(start) || !validMetricDate(end) || start >= end) {
    throw Object.assign(new Error('start and end must be a valid closed-open date range'), { status: 400 });
  }
  const maximumDays = resolution === 'five-minute' || resolution === 'hour' ? 7 : 366;
  if ((Date.parse(end) - Date.parse(start)) / DAY_MS > maximumDays) {
    throw Object.assign(new Error(`This resolution supports at most ${maximumDays} days; use daily summaries or an export for longer ranges`), { status: 400 });
  }
}
