export const ANALYSIS_VERSION = "sleep-overview-v1";
export const BASELINE_RULE = {
  calendarDays: 28,
  minimumNights: 14,
  percentiles: [10, 90],
  excludeSelectedDate: true,
};
export const shiftDate = (date, days) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const wrap = (value) => ((value % 1440) + 1440) % 1440;
const clockDelta = (value, center) => ((value - center + 2160) % 1440) - 720;
const quantile = (sorted, p) => {
  const position = (sorted.length - 1) * p,
    lo = Math.floor(position);
  return (
    sorted[lo] + (sorted[Math.ceil(position)] - sorted[lo]) * (position - lo)
  );
};
export function personalBaseline(
  entries,
  { date, sourceKey, method, value, circular = false },
) {
  const start = shiftDate(date, -28);
  const candidates = entries.filter(
    (x) =>
      x.date >= start &&
      x.date < date &&
      x.sourceKey === sourceKey &&
      x.method === method &&
      x.eligible !== false &&
      finite(x.value),
  );
  const byDate = new Map();
  for (const entry of candidates) {
    const group = byDate.get(entry.date) ?? [];
    group.push(entry);
    byDate.set(entry.date, group);
  }
  const usable = [...byDate.values()]
    .filter((group) => group.length === 1)
    .map((group) => group[0]);
  const result = {
    start,
    endExclusive: date,
    count: usable.length,
    required: 14,
    dates: usable.map((x) => x.date).sort(),
    observations: usable.map(({ date, value, sourceKey, method }) => ({
      date,
      value,
      sourceKey,
      method,
    })),
    median: null,
    p10: null,
    p90: null,
    delta: null,
    comparison: "insufficient",
    circular,
  };
  if (usable.length < 14) return result;
  const anchor = circular
    ? wrap(
        (Math.atan2(
          usable.reduce((s, x) => s + Math.sin((x.value * Math.PI) / 720), 0),
          usable.reduce((s, x) => s + Math.cos((x.value * Math.PI) / 720), 0),
        ) *
          720) /
          Math.PI,
      )
    : 0;
  const values = usable
    .map((x) => (circular ? anchor + clockDelta(x.value, anchor) : x.value))
    .sort((a, b) => a - b);
  const median = quantile(values, 0.5),
    low = quantile(values, 0.1),
    high = quantile(values, 0.9);
  const current = finite(value)
    ? circular
      ? anchor + clockDelta(value, anchor)
      : value
    : null;
  return {
    ...result,
    median: circular ? wrap(median) : median,
    p10: circular ? wrap(low) : low,
    p90: circular ? wrap(high) : high,
    delta: current === null ? null : current - median,
    comparison:
      current === null
        ? "unavailable"
        : Math.abs(high - low) < 1e-8
          ? "flat"
          : current < low
            ? "below"
            : current > high
              ? "above"
              : "within",
  };
}
export const isAsleep = (stage) =>
  ["light", "deep", "rem", "asleep"].includes(stage.type?.toLowerCase());
export function sleepingHeart(session, samples, sourceKey) {
  const intervals = session.stages
    .filter(isAsleep)
    .map((s) => [
      Math.max(Date.parse(s.startTime), Date.parse(session.startTime)),
      Math.min(Date.parse(s.endTime), Date.parse(session.endTime)),
    ])
    .filter(([a, b]) => b > a);
  const bins = new Set();
  for (const [a, b] of intervals)
    for (
      let minute = Math.floor(a / 60000);
      minute < Math.ceil(b / 60000);
      minute++
    )
      bins.add(minute);
  const atTime = new Map();
  for (const sample of samples.filter((x) => x.sourceKey === sourceKey)) {
    const time = Date.parse(sample.sampledAt);
    if (
      !finite(sample.beatsPerMinute) ||
      !intervals.some(([a, b]) => time >= a && time < b)
    )
      continue;
    const key = sample.sampledAt,
      values = atTime.get(key) ?? new Set();
    values.add(sample.beatsPerMinute);
    atTime.set(key, values);
  }
  const minutes = new Map();
  let conflicts = 0;
  for (const [time, values] of atTime) {
    if (values.size !== 1) {
      conflicts++;
      continue;
    }
    const key = Math.floor(Date.parse(time) / 60000),
      valuesInMinute = minutes.get(key) ?? [];
    valuesInMinute.push([...values][0]);
    minutes.set(key, valuesInMinute);
  }
  const means = [...minutes.values()].map(
    (v) => v.reduce((a, b) => a + b, 0) / v.length,
  );
  const coverageFraction = bins.size ? means.length / bins.size : 0;
  return {
    value: means.length
      ? means.reduce((a, b) => a + b, 0) / means.length
      : null,
    eligible: coverageFraction >= 0.8 && session.processed !== false,
    sourceKey,
    method: "asleep-minute-mean-v1",
    coverageFraction,
    usableMinuteBins: means.length,
    asleepMinuteBins: bins.size,
    conflicts,
    completenessRule:
      "At least 80% of identified asleep minute bins must contain usable readings. This measures application completeness, not sensor accuracy.",
  };
}
export function totalSleep(sessions) {
  const sorted = [...sessions].sort(
    (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
  );
  if (
    sorted.some(
      (s, i) =>
        !finite(s.minutesAsleep) ||
        (i > 0 && Date.parse(s.startTime) < Date.parse(sorted[i - 1].endTime)),
    )
  )
    return {
      minutesAsleep: null,
      reason: "Overlapping sessions or unavailable asleep duration",
      sessionCount: sessions.length,
    };
  return {
    minutesAsleep: sorted.length
      ? sorted.reduce((sum, s) => sum + s.minutesAsleep, 0)
      : null,
    reason: null,
    sessionCount: sessions.length,
  };
}
function clockMinute(time, offset, timezone) {
  if (finite(offset)) {
    const d = new Date(Date.parse(time) + offset * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  }
  if (!timezone) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(time));
  return (
    Number(parts.find((x) => x.type === "hour").value) * 60 +
    Number(parts.find((x) => x.type === "minute").value)
  );
}
export function sessionMetrics(session, timezone) {
  const durationValid =
    finite(session.minutesAsleep) &&
    session.minutesAsleep >= 0 &&
    session.minutesAsleep <= session.durationMinutes;
  const base = {
    sourceKey: session.sourceKey,
    method: `provider-sleep-${session.type}-v2`,
    eligible: session.processed !== false && !session.conflict && durationValid,
  };
  const measurement = (value, unit, label, extra = {}) => ({
    ...base,
    value: finite(value) ? value : null,
    unit,
    label,
    ...extra,
  });
  const asleep = session.stages.filter(isAsleep),
    first = Math.min(...asleep.map((x) => Date.parse(x.startTime))),
    last = Math.max(...asleep.map((x) => Date.parse(x.endTime)));
  const wakes = session.stages.filter((x) =>
    ["awake", "wake"].includes(x.type),
  );
  const interior = wakes.filter(
    (x) => Date.parse(x.startTime) >= first && Date.parse(x.endTime) <= last,
  );
  const ordered = [...session.stages].sort(
    (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime),
  );
  const completeStages =
    ordered.length > 0 &&
    Date.parse(ordered[0].startTime) === Date.parse(session.startTime) &&
    Date.parse(ordered.at(-1).endTime) === Date.parse(session.endTime) &&
    ordered.every(
      (s, i) =>
        Date.parse(s.endTime) > Date.parse(s.startTime) &&
        (!i || Date.parse(s.startTime) === Date.parse(ordered[i - 1].endTime)),
    );
  const stageEligibility = {
    eligible: base.eligible && completeStages,
    coverageRule:
      "Continuous non-overlapping recorded stages are required for interior-wake comparisons",
  };
  return {
    duration: measurement(session.minutesAsleep, "min", "Actual time asleep", {
      method: `sleep-${session.type}-${session.asleepDerivation ?? "provider-summary"}-v1`,
    }),
    awake: measurement(session.minutesAwake, "min", "Recorded awake time", {
      method: `sleep-${session.type}-${session.awakeDerivation ?? "provider-summary"}-v1`,
    }),
    efficiency: measurement(
      session.durationMinutes > 0 && finite(session.minutesAsleep)
        ? (100 * session.minutesAsleep) / session.durationMinutes
        : null,
      "%",
      "Sleep efficiency",
      {
        method: `asleep-${session.asleepDerivation ?? "provider-summary"}-over-elapsed-period-v1`,
      },
    ),
    afterOnset: measurement(
      asleep.length
        ? wakes.reduce(
            (sum, x) =>
              sum +
              Math.max(
                0,
                Math.min(Date.parse(x.endTime), last) -
                  Math.max(Date.parse(x.startTime), first),
              ) /
                60000,
            0,
          )
        : null,
      "min",
      "Awake after sleep onset (excluding final wakefulness)",
      { method: "stage-interior-awake-v1", ...stageEligibility },
    ),
    initialAwake: measurement(
      asleep.length && completeStages
        ? wakes
            .filter((x) => Date.parse(x.endTime) <= first)
            .reduce(
              (sum, x) =>
                sum + (Date.parse(x.endTime) - Date.parse(x.startTime)) / 60000,
              0,
            )
        : null,
      "min",
      "Initial wakefulness",
      { method: "stage-initial-awake-v1", ...stageEligibility },
    ),
    finalAwake: measurement(
      asleep.length && completeStages
        ? wakes
            .filter((x) => Date.parse(x.startTime) >= last)
            .reduce(
              (sum, x) =>
                sum + (Date.parse(x.endTime) - Date.parse(x.startTime)) / 60000,
              0,
            )
        : null,
      "min",
      "Final wakefulness",
      { method: "stage-final-awake-v1", ...stageEligibility },
    ),
    awakenings: measurement(
      asleep.length ? interior.length : null,
      "episodes",
      "Interior awake episodes",
      { method: "stage-interior-episodes-v1", ...stageEligibility },
    ),
    bedtime: measurement(
      clockMinute(session.startTime, session.startOffsetSeconds, timezone),
      "clock",
      "Bedtime",
      { method: "local-clock-v1", circular: true },
    ),
    wakeTime: measurement(
      clockMinute(session.endTime, session.endOffsetSeconds, timezone),
      "clock",
      "Wake time",
      { method: "local-clock-v1", circular: true },
    ),
  };
}
const PHYSIOLOGY = {
  sleepingHr: ["Sleeping heart rate", "bpm"],
  hrv: ["Daily HRV", "ms"],
  breathing: ["Breathing rate", "breaths/min"],
  temperature: ["Skin temperature", "°C"],
  spo2: ["Daily SpO₂", "%"],
};
export function assessNight({
  session,
  history = [],
  goalMinutes = 420,
  date = session.date,
  physiology = {},
  timezone = null,
}) {
  const metrics = sessionMetrics(session, timezone);
  for (const [key, [label, unit]] of Object.entries(PHYSIOLOGY))
    metrics[key] = {
      label,
      unit,
      value: null,
      eligible: false,
      method: null,
      sourceKey: null,
      ...physiology[key],
    };
  const findings = [],
    notes = [];
  for (const [key, metric] of Object.entries(metrics)) {
    metric.baseline = personalBaseline(
      history.map((x) => ({ date: x.date, ...x.metrics?.[key] })),
      { ...metric, date },
    );
    metric.assessable =
      metric.eligible && finite(metric.value) && metric.baseline.count >= 14;
  }
  metrics.duration.goalMinutes = goalMinutes;
  metrics.duration.goalDifferenceMinutes = finite(session.minutesAsleep)
    ? session.minutesAsleep - goalMinutes
    : null;
  function add(key, text) {
    findings.push({ key, text, evidence: metrics[key] });
  }
  if (metrics.duration.eligible && metrics.duration.goalDifferenceMinutes < 0)
    add("duration", "Shorter than your goal");
  if (metrics.awake.assessable && metrics.awake.baseline.comparison === "above")
    add("awake", "More wakefulness than usual");
  for (const key of ["bedtime", "wakeTime"])
    if (
      metrics[key].assessable &&
      ["below", "above"].includes(metrics[key].baseline.comparison)
    ) {
      add(key, "A change in your sleep schedule");
      break;
    }
  for (const [key, [label]] of Object.entries(PHYSIOLOGY)) {
    const m = metrics[key];
    if (m.assessable && ["below", "above"].includes(m.baseline.comparison))
      add(key, `${label} ${m.baseline.comparison} your recent range`);
    if (!finite(m.value) || !m.eligible)
      notes.push(
        `${label}: ${m.state === "daily-summary-not-nap" ? "provider-date summary; not a measurement of this nap" : m.state === "conflict" ? "source conflict" : m.state === "selection-required" ? "choose a source" : finite(m.value) ? "incomplete observations; excluded from comparisons" : "unavailable"}.`,
      );
  }
  if (session.processed === false)
    notes.unshift("Provisional sleep record — provider processing is pending.");
  const coreReady = ["duration", "awake", "bedtime", "wakeTime"].every(
    (k) => metrics[k].assessable,
  );
  const headline =
    findings
      .slice(0, 2)
      .map((x) => x.text)
      .join(". ") ||
    (session.processed === false
      ? "Sleep is still being processed"
      : coreReady
        ? "Similar to recent nights"
        : "Your recorded sleep");
  return {
    analysisVersion: ANALYSIS_VERSION,
    baselineRule: BASELINE_RULE,
    headline,
    findings,
    headlineFindings: findings.slice(0, 2),
    notes,
    metrics,
    provisional: session.processed === false,
    indicators: [
      { key: "duration", label: "Duration", metrics: ["duration"] },
      {
        key: "continuity",
        label: "Continuity",
        metrics: [
          "awake",
          "efficiency",
          "afterOnset",
          "initialAwake",
          "finalAwake",
          "awakenings",
        ],
      },
      {
        key: "regularity",
        label: "Regularity",
        metrics: ["bedtime", "wakeTime"],
      },
      {
        key: "signals",
        label: "Overnight signals",
        metrics: Object.keys(PHYSIOLOGY),
      },
    ],
  };
}
