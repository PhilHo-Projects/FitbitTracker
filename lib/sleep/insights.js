import { BASELINE_RULE, personalBaseline, shiftDate } from './analysis.js';
import { CHECK_IN_CONTEXT } from './check-ins.js';

export const INSIGHTS_VERSION = 'sleep-insights-v1';
export const INSIGHT_METRICS = {
  duration: ['Median time asleep', 'min'], goalMet: ['Nights meeting your goal', '%'],
  afterOnset: ['Awake after sleep onset (excluding final wakefulness)', 'min'], efficiency: ['Sleep efficiency', '%'],
  bedtimeConsistency: ['Bedtime clock deviation', 'min'], wakeTimeConsistency: ['Wake-time clock deviation', 'min'],
  sleepingHr: ['Sleeping heart rate', 'bpm'], hrv: ['Daily HRV', 'ms'], breathing: ['Breathing rate', 'breaths/min'],
  temperature: ['Skin temperature', '°C'], spo2: ['Daily SpO₂', '%'],
};
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
};
const wrap = x => ((x % 1440) + 1440) % 1440;
const clockDelta = (a, b) => wrap(a - b + 720) - 720;
export function clockConsistency(values) {
  if (!values.length) return null;
  // A circular L1 median minimizes total clock distance. Unwrap around a minimizing
  // observation so an even pair spanning midnight has its median between the times.
  const candidates = [...new Set(values)].sort((a, b) => a - b);
  const loss = center => values.reduce((sum, value) => sum + Math.abs(clockDelta(value, center)), 0);
  let anchor = candidates[0];
  for (const value of candidates) if (loss(value) < loss(anchor) - 1e-8) anchor = value;
  const center = wrap(median(values.map(value => anchor + clockDelta(value, anchor))));
  return median(values.map(value => Math.abs(clockDelta(value, loss(center) <= loss(anchor) + 1e-8 ? center : anchor))));
}
const mainEligible = night => night.session && !night.session.isNap && night.session.processed !== false && !night.session.conflict;
function observations(nights, key) {
  const underlying = { goalMet: 'duration', bedtimeConsistency: 'bedtime', wakeTimeConsistency: 'wakeTime' }[key] ?? key;
  return nights.flatMap(night => {
    const metric = night.metrics?.[underlying];
    return mainEligible(night) && metric?.eligible === true && Number.isFinite(metric.value)
      ? [{ date: night.date, value: metric.value, sourceKey: metric.sourceKey ?? null, method: metric.method ?? null }] : [];
  });
}
function summarize(entries, key, required, goalMinutes) {
  const methods = [...new Set(entries.map(x => JSON.stringify([x.sourceKey, x.method])))];
  const reason = methods.length > 1 ? 'mixed-sources-or-methods' : entries.length < required ? 'insufficient-observations' : null;
  const values = entries.map(x => x.value);
  const measured = key === 'goalMet' ? (values.length ? 100 * values.filter(x => x >= goalMinutes).length / values.length : null)
    : key.endsWith('Consistency') ? clockConsistency(values) : median(values);
  return { value: reason ? null : measured, count: entries.length, required, dates: entries.map(x => x.date),
    reason, identity: methods.length === 1 ? { sourceKey: entries[0].sourceKey, method: entries[0].method } : null };
}
function difference(first, second) {
  const reason = first.reason ?? second.reason ??
    (JSON.stringify(first.identity) !== JSON.stringify(second.identity) ? 'mixed-sources-or-methods' : null);
  return { value: reason ? null : first.value - second.value, reason, direction: 'first-minus-second' };
}
function groupComparison(first, second, checkIns) {
  return Object.fromEntries(['duration', 'afterOnset', 'restfulness'].map(key => {
    const entries = nights => key === 'restfulness'
      ? nights.filter(mainEligible).flatMap(n => {
        const value = checkIns.get(n.date)?.restfulness;
        return [1, 2, 3, 4, 5].includes(value) ? [{ date: n.date, value, sourceKey: 'self-report', method: 'restfulness-1-to-5' }] : [];
      }) : observations(nights, key);
    const a = summarize(entries(first), key, 7), b = summarize(entries(second), key, 7);
    return [key, { label: key === 'restfulness' ? 'Reported restfulness' : INSIGHT_METRICS[key][0],
      unit: key === 'restfulness' ? '/5' : 'min', first: a, second: b, difference: difference(a, b) }];
  }));
}
export function buildSleepInsights({ date, days = 30, nights = [], goalMinutes = 420, timezone = null,
  sources = {}, checkIns = [], includeSleepCheckIns = true, checkInsAvailable = true, availability = {}, freshness = {} }) {
  const end = shiftDate(date, 1), start = shiftDate(end, -days), previousStart = shiftDate(start, -days);
  const selected = nights.filter(n => n.date >= start && n.date < end);
  const prior = nights.filter(n => n.date >= previousStart && n.date < start);
  const required = Math.ceil(days / 2);
  function period(entries, startDate, endDateExclusive) {
    return { startDate, endDateExclusive, calendarNights: days, recordedNights: entries.filter(n => n.session && !n.session.isNap).length,
      metrics: Object.fromEntries(Object.entries(INSIGHT_METRICS).map(([key, [label, unit]]) => [key,
        { label, unit, ...summarize(observations(entries, key), key, required, goalMinutes) }])) };
  }
  const current = period(selected, start, end), previous = period(prior, previousStart, start);
  const differences = Object.fromEntries(Object.keys(INSIGHT_METRICS).map(key => [key, difference(current.metrics[key], previous.metrics[key])]));
  const byDate = new Map(checkIns.map(entry => [entry.date, entry]));
  const high = selected.filter(n => [4, 5].includes(byDate.get(n.date)?.restfulness));
  const low = selected.filter(n => [1, 2].includes(byDate.get(n.date)?.restfulness));
  const baselineNight = nights.find(n => n.date === date);
  const baselineEvidence = Object.fromEntries(Object.entries(baselineNight?.metrics ?? {}).map(([key, m]) => [key,
    { value: m.value, eligible: !!mainEligible(baselineNight) && m.eligible, sourceKey: m.sourceKey, method: m.method,
      ...personalBaseline(nights.filter(mainEligible).map(n => ({ date: n.date, ...n.metrics?.[key] })), { date, ...m }) }]));
  return { schemaVersion: INSIGHTS_VERSION, date, days, timezone, sources, goalMinutes, current, previous, differences,
    sourceChoices: Object.fromEntries(['sleepingHr', 'hrv', 'breathing', 'temperature', 'spo2'].map(key => [key,
      [...new Map(nights.filter(n => n.date >= previousStart).flatMap(n => n.metrics?.[key]?.sources ?? []).map(source => [source.key, source])).values()]])),
    baselineRule: BASELINE_RULE, baselineEvidence, availability, freshness,
    rules: { periods: 'At least half the calendar nights per metric in both periods, with one matching source and method. Goal percentage is calculated among usable main-sleep nights.',
      consistency: 'Median absolute clock-time deviation from a circular median, in minutes; recorded offsets preserve local times across DST.',
      habits: 'At least seven usable nights in each group for each outcome. Descriptive associations, not causes or tests of statistical significance.',
      missing: 'Missing measurements are unknown, not normal physiology. Naps are separate. Free-text notes are excluded.' },
    ...(includeSleepCheckIns ? { checkInComparisons: {
      available: checkInsAvailable,
      restfulness: { firstLabel: 'Restfulness 4–5', secondLabel: 'Restfulness 1–2',
        neutralDates: selected.filter(n => byDate.get(n.date)?.restfulness === 3).map(n => n.date),
        unansweredDates: selected.filter(n => !byDate.get(n.date)?.restfulness).map(n => n.date),
        metrics: groupComparison(high, low, byDate) },
      factors: CHECK_IN_CONTEXT.map(factor => ({ factor, firstLabel: `${factor} recorded`, secondLabel: `${factor} absent after review`,
        metrics: groupComparison(selected.filter(n => byDate.get(n.date)?.context?.includes(factor)),
          selected.filter(n => byDate.get(n.date)?.contextReviewed === true && !byDate.get(n.date)?.context?.includes(factor)), byDate) })),
    } } : {}),
    nights: selected.map(n => ({ date: n.date, sessionId: n.session?.id ?? null,
      state: !n.session ? 'missing' : n.session.isNap ? 'nap-only' : n.session.processed === false ? 'provisional' : n.session.conflict ? 'conflicting-sources' : 'recorded',
      metrics: Object.fromEntries(Object.entries(n.metrics ?? {}).map(([key, m]) => [key, { value: m.value, eligible: !!mainEligible(n) && m.eligible === true,
        sourceKey: m.sourceKey, method: m.method, unit: m.unit ?? INSIGHT_METRICS[key]?.[1] ?? null }])),
      naps: { count: n.sessions?.filter(s => s.isNap).length ?? 0,
        minutesAsleep: n.sessions?.filter(s => s.isNap).reduce((sum, s) => sum === null || s.minutesAsleep == null ? null : sum + s.minutesAsleep, 0) ?? 0 },
      ...(includeSleepCheckIns ? { checkIn: byDate.has(n.date) ? { restfulness: byDate.get(n.date).restfulness ?? null,
        awakenings: byDate.get(n.date).awakenings ?? null, contextReviewed: byDate.get(n.date).contextReviewed === true,
        context: byDate.get(n.date).context ?? [] } : null } : {}),
    })),
  };
}
