import { GOOGLE_HEALTH_METRICS } from './planner.js';

const BASE = 'https://health.googleapis.com/v4/users/me';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const OPERATIONS = new Set(['profile', 'identity', 'list', 'reconcile', 'rollUp']);

export const COMBINATIONS = {
  profile: new Set(['sleep']),
  identity: new Set(['sleep']),
  list: new Set([
    'heart-rate',
    'daily-resting-heart-rate',
    'active-energy-burned',
    'basal-energy-burned',
  ]),
  reconcile: new Set(['sleep']),
  rollUp: new Set(['total-calories']),
};

export const FILTER_FIELDS = {
  sleep: 'sleep.interval.civil_end_time',
  'heart-rate': 'heart_rate.sample_time.civil_time',
  'daily-resting-heart-rate': 'daily_resting_heart_rate.date',
  'active-energy-burned': 'active_energy_burned.interval.civil_start_time',
  'basal-energy-burned': 'basal_energy_burned.interval.civil_start_time',
};

export function validateGoogleHealthRequest(request) {
  if (
    !OPERATIONS.has(request.operation) ||
    !GOOGLE_HEALTH_METRICS.includes(request.metric) ||
    !COMBINATIONS[request.operation]?.has(request.metric)
  ) {
    throw new Error('Unsupported gateway request');
  }
  if (!['profile', 'identity'].includes(request.operation)) {
    if (
      !DATE_PATTERN.test(String(request.startDate || '')) ||
      !DATE_PATTERN.test(String(request.endDateExclusive || '')) ||
      request.startDate >= request.endDateExclusive
    ) {
      throw new Error('Unsupported gateway request');
    }
  }
  if (request.operation === 'rollUp' && !String(request.timezone || '').trim()) {
    throw new Error('Unsupported gateway request');
  }
}

function zonedIso(date, timezone) {
  // Resolve the UTC instant of local midnight on `date` in `timezone`.
  const target = Date.parse(`${date}T00:00:00Z`);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  // Re-evaluate the offset at the candidate instant: DST may lie between UTC
  // midnight and local midnight, so a single offset calculation is insufficient.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const value = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(({ type, value: part }) => [type, part]));
    const asUtc = Date.parse(`${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}Z`);
    if (asUtc === target) return new Date(guess).toISOString();
    guess += target - asUtc;
  }
  throw Object.assign(new Error('Unsupported gateway request: local midnight does not exist'), { transient: false });
}

export function buildGoogleHealthRequest(request) {
  validateGoogleHealthRequest(request);

  if (request.operation === 'profile' || request.operation === 'identity') {
    return { method: 'GET', url: `${BASE}/${request.operation}`, body: null };
  }

  if (request.operation === 'rollUp') {
    return {
      method: 'POST',
      url: `${BASE}/dataTypes/${request.metric}/dataPoints:rollUp`,
      body: {
        range: {
          startTime: zonedIso(request.startDate, request.timezone),
          endTime: zonedIso(request.endDateExclusive, request.timezone),
        },
        windowSize: '3600s',
      },
    };
  }

  const suffix = request.operation === 'reconcile' ? 'dataPoints:reconcile' : 'dataPoints';
  const filterField = FILTER_FIELDS[request.metric];
  const query = new URLSearchParams({
    pageSize: request.metric === 'sleep' ? '25' : '10000',
    filter:
      `${filterField} >= "${request.startDate}" AND ${filterField} < "${request.endDateExclusive}"`,
  });
  if (request.operation === 'reconcile') {
    query.set('dataSourceFamily', 'users/me/dataSourceFamilies/google-wearables');
  }
  if (request.pageToken) query.set('pageToken', request.pageToken);

  return {
    method: 'GET',
    url: `${BASE}/dataTypes/${request.metric}/${suffix}?${query.toString()}`,
    body: null,
  };
}
