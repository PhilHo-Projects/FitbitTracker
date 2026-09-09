import { createSleepRepository, num } from "./repository.js";
import {
  assessNight,
  sessionMetrics,
  sleepingHeart,
  totalSleep,
  shiftDate,
  ANALYSIS_VERSION,
  BASELINE_RULE,
} from "./analysis.js";
import { sleepDate, sleepRange } from "./check-ins.js";

const badRequest = (message) =>
  Object.assign(new Error(message), { status: 400 });
export function validateSleepSources(sources = {}) {
  const keys = [
    "sleepingHr",
    "hrv",
    "breathing",
    "temperature",
    "spo2",
    "heartTrack",
    "spo2Track",
    "hrvTrack",
  ];
  if (
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    Object.entries(sources).some(
      ([key, value]) =>
        !keys.includes(key) ||
        typeof value !== "string" ||
        !/^[a-f0-9]{64}$/.test(value),
    )
  )
    throw badRequest("Invalid sleep source selection");
  return sources;
}
export function mainSleep(sessions) {
  return (
    sessions
      .filter((s) => !s.isNap)
      .sort(
        (a, b) =>
          b.durationMinutes - a.durationMinutes || a.id.localeCompare(b.id),
      )[0] ?? null
  );
}
function sourcesFor(rows) {
  return [
    ...new Map(
      rows.map((row) => [
        row.sourceKey,
        {
          key: row.sourceKey,
          label:
            row.sourceMetadata?.device?.displayName ??
            row.sourceMetadata?.device?.model ??
            row.sourceMetadata?.application?.displayName ??
            "Source not identified",
        },
      ]),
    ).values(),
  ].sort((a, b) => a.key.localeCompare(b.key));
}
function choice(rows, requested) {
  const sources = sourcesFor(rows),
    sourceKey = requested ?? (sources.length === 1 ? sources[0].key : null);
  return {
    sources,
    sourceKey,
    selected: rows.filter((x) => x.sourceKey === sourceKey),
    state:
      sources.length > 1 && !sourceKey
        ? "selection-required"
        : sourceKey && !sources.some((x) => x.key === sourceKey)
          ? "source-unavailable"
          : rows.length
            ? "available"
            : "unavailable",
  };
}
function daily(rows, field, method, requested, date) {
  const candidates = rows.map((row) => ({
    providerId: row.provider_id,
    sourceKey: row.source_key,
    sourceMetadata: row.source_metadata,
    value: num(row[field]),
    sourceFields: row.source_fields,
    qualityFlags: row.quality_flags ?? [],
    providerDate: row.civil_date,
  }));
  const chosen = choice(candidates, requested),
    item = chosen.selected.length === 1 ? chosen.selected[0] : null;
  const conflict = chosen.selected.length > 1;
  return {
    value: item?.value ?? null,
    sourceKey: chosen.sourceKey,
    method,
    eligible:
      !!item &&
      item.value !== null &&
      !item.qualityFlags.length &&
      item.sourceFields?.quality?.valid !== false,
    providerDate: date,
    association: "provider-date",
    state: conflict ? "conflict" : chosen.state,
    sources: chosen.sources,
    candidates,
    sourceFields: item?.sourceFields ?? null,
    qualityFlags: item?.qualityFlags ?? [],
  };
}
function heartFor(session, points, requested) {
  const chosen = choice(points, requested);
  return {
    ...sleepingHeart(session, points, chosen.sourceKey),
    sources: chosen.sources,
    state: chosen.state,
  };
}
function physiologyFor(date, session, vitals, heart, sources) {
  const rows = (metric) =>
    (vitals[metric] ?? []).filter((x) => x.civil_date === date);
  return {
    sleepingHr: session
      ? heartFor(
          session,
          heart.filter((x) => x.sessionId === session.id),
          sources.sleepingHr,
        )
      : { value: null, eligible: false },
    hrv: daily(
      rows("daily-heart-rate-variability"),
      "rmssd_ms",
      "provider-daily-rmssd-v1",
      sources.hrv,
      date,
    ),
    breathing: daily(
      rows("daily-respiratory-rate"),
      "breaths_per_minute",
      "provider-daily-respiratory-v1",
      sources.breathing,
      date,
    ),
    temperature: daily(
      rows("daily-sleep-temperature-derivations"),
      "temperature_celsius",
      "provider-nightly-temperature-v1",
      sources.temperature,
      date,
    ),
    spo2: daily(
      rows("daily-oxygen-saturation"),
      "average_percentage",
      "provider-daily-oxygen-v1",
      sources.spo2,
      date,
    ),
  };
}
function makeTrack(points, requested, truncated) {
  const chosen = choice(points, requested),
    byTime = new Map();
  for (const point of chosen.selected) {
    const group = byTime.get(point.sampledAt) ?? [];
    group.push(point);
    byTime.set(point.sampledAt, group);
  }
  const samples = [...byTime.values()]
    .map((group) => ({
      ...group[0],
      conflict: new Set(group.map((x) => x.value)).size > 1,
      observations: group.length,
    }))
    .sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  // Point observations are not durations. Gaps are left open; no oxygen-dip duration is inferred.
  return {
    state: chosen.state,
    sources: chosen.sources,
    sourceKey: chosen.sourceKey,
    samples,
    truncated,
    observationCount: chosen.selected.length,
    conflictCount: samples.filter((x) => x.conflict).length,
    rendering: "individual-observations",
    coverageSemantics:
      "Observed timestamps only; no interpolation or inferred continuous coverage",
  };
}
export function createSleepService({ pool }) {
  const repository = createSleepRepository(pool);
  async function load(account, start, end, sources) {
    const [sessions, vitals] = await Promise.all([
      repository.sessions(account.id, start, end),
      repository.vitalRows(account.id, start, end),
    ]);
    for (const s of sessions)
      s.conflict = sessions.some(
        (other) =>
          other.id !== s.id &&
          other.date === s.date &&
          other.sourceKey !== s.sourceKey &&
          Date.parse(other.startTime) < Date.parse(s.endTime) &&
          Date.parse(other.endTime) > Date.parse(s.startTime),
      );
    const heart = await repository.heartBins(account.id, start, end, sessions);
    const nights = [];
    for (let date = start; date < end; date = shiftDate(date, 1)) {
      const daySessions = sessions.filter((x) => x.date === date),
        session = mainSleep(daySessions),
        physiology = physiologyFor(date, session, vitals, heart, sources);
      nights.push({
        date,
        session,
        sessions: daySessions,
        totalSleep: totalSleep(daySessions),
        physiology,
        metrics: session
          ? { ...sessionMetrics(session, account.timezone), ...physiology }
          : physiology,
      });
    }
    return { nights, sessions, vitals, heart };
  }
  async function getPreferences() {
    const account = await repository.account();
    return account ? repository.preferences(account.id) : { goalMinutes: 420 };
  }
  return {
    repository,
    getPreferences,
    async setPreferences({ goalMinutes } = {}) {
      if (
        !Number.isInteger(goalMinutes) ||
        goalMinutes < 60 ||
        goalMinutes > 1440
      )
        throw badRequest("Sleep goal must be 60–1440 whole minutes");
      const account = await repository.account();
      if (!account)
        throw Object.assign(new Error("Connect a source account first"), {
          status: 409,
        });
      return repository.savePreferences(account.id, goalMinutes);
    },
    async report({ date, sessionId, sources = {}, includeTracks = true } = {}) {
      validateSleepSources(sources);
      if (date) sleepDate(date);
      if (
        sessionId &&
        (typeof sessionId !== "string" || !/^[a-f0-9-]{36}$/i.test(sessionId))
      )
        throw badRequest("Invalid sleep session");
      const account = await repository.account();
      if (!account)
        return {
          date: date ?? null,
          session: null,
          sessions: [],
          dates: [],
          assessment: null,
          timezone: null,
          availability: {},
          preferences: { goalMinutes: 420 },
        };
      const [dates, preferences] = await Promise.all([
        repository.dates(account.id),
        repository.preferences(account.id),
      ]);
      date ??= dates[0];
      if (!date)
        return {
          date: null,
          session: null,
          sessions: [],
          dates,
          assessment: null,
          timezone: account.timezone,
          availability: {},
          preferences,
        };
      const loaded = await load(
          account,
          shiftDate(date, -28),
          shiftDate(date, 1),
          sources,
        ),
        selectedDay = loaded.nights.find((x) => x.date === date);
      const session = sessionId
        ? selectedDay.sessions.find((x) => x.id === sessionId)
        : (selectedDay.session ?? selectedDay.sessions[0] ?? null);
      if (sessionId && !session)
        throw Object.assign(
          new Error("Sleep session is unavailable on this date"),
          { status: 404 },
        );
      const availability = await repository.availability(account.id, date);
      if (!session)
        return {
          date,
          session: null,
          sessions: [],
          dates,
          assessment: null,
          timezone: account.timezone,
          availability,
          preferences,
        };
      const physiology = physiologyFor(
        date,
        session,
        loaded.vitals,
        loaded.heart,
        sources,
      );
      // Daily provider summaries remain visible but cannot become findings about a nap.
      const assessPhysiology = Object.fromEntries(
        Object.entries(physiology).map(([key, value]) => [
          key,
          session.isNap && value.association === "provider-date"
            ? { ...value, eligible: false, state: "daily-summary-not-nap" }
            : value,
        ]),
      );
      const history = loaded.nights.filter(
        (x) => x.session && !x.session.isNap && x.date !== date,
      );
      const assessment = assessNight({
        session,
        history: session.isNap ? [] : history,
        goalMinutes: preferences.goalMinutes,
        date,
        physiology: assessPhysiology,
        timezone: account.timezone,
      });
      if (session.isNap) {
        assessment.headline = "Recorded nap";
        assessment.metrics.duration.goalDifferenceMinutes = null;
        for (const metric of Object.values(assessment.metrics)) metric.comparisonContext = 'nap';
        assessment.findings = assessment.findings.filter(
          (x) => x.key !== "duration",
        );
        assessment.headlineFindings = [];
      }
      if (session.conflict)
        assessment.notes.unshift(
          "Overlapping sleep sources need review. Conflicting measurements are excluded from assessment statements.",
        );
      let tracks = null;
      if (includeTracks) {
        const raw = await repository.tracks(account.id, session);
        tracks = {
          startTime: session.startTime,
          endTime: session.endTime,
          stages: session.stages,
          outOfBed: session.outOfBedSegments,
          heart: makeTrack(
            raw.heart,
            sources.heartTrack ?? sources.sleepingHr,
            raw.truncated.heart,
          ),
          spo2: makeTrack(raw.spo2, sources.spo2Track, raw.truncated.spo2),
          hrv: makeTrack(raw.hrv, sources.hrvTrack, raw.truncated.hrv),
        };
      }
      const observations = {
        sleep: selectedDay.sessions.length,
        "heart-rate":
          tracks?.heart.observationCount ??
          physiology.sleepingHr.usableMinuteBins,
        "oxygen-saturation": tracks?.spo2.observationCount ?? null,
        "heart-rate-variability": tracks?.hrv.observationCount ?? null,
        "daily-heart-rate-variability": physiology.hrv.candidates.length,
        "daily-respiratory-rate": physiology.breathing.candidates.length,
        "daily-sleep-temperature-derivations":
          physiology.temperature.candidates.length,
        "daily-oxygen-saturation": physiology.spo2.candidates.length,
        "respiratory-rate-sleep-summary": (
          loaded.vitals["respiratory-rate-sleep-summary"] ?? []
        ).filter((x) => x.civil_date === date).length,
      };
      for (const [key, value] of Object.entries(availability)) {
        value.recordCount = observations[key];
        value.observationState =
          value.recordCount > 0
            ? "saved-observations"
            : value.recordCount === 0 && value.fetchComplete
              ? "empty-completed-fetch"
              : value.recordCount === 0
                ? "no-saved-observations"
                : "not-loaded";
      }
      availability.sleep.processing =
        session.processed === false
          ? "pending"
          : session.processed === true
            ? "processed"
            : "unknown";
      availability["heart-rate"].observationCoverage = {
        fraction: physiology.sleepingHr.coverageFraction,
        rule: physiology.sleepingHr.completenessRule,
      };
      return {
        date,
        session,
        sessions: selectedDay.sessions,
        mainSessionId: selectedDay.session?.id ?? null,
        checkInDate: selectedDay.session?.date ?? null,
        dates,
        timezone: account.timezone,
        preferences,
        assessment,
        physiology,
        totalSleep: selectedDay.totalSleep,
        tracks,
        availability,
        newestMeasurementAt: [
          session.endTime,
          ...(tracks
            ? ["heart", "spo2", "hrv"].flatMap((k) =>
                tracks[k].samples.map((s) => s.sampledAt),
              )
            : []),
        ]
          .sort()
          .at(-1),
        respiratorySummaries: (
          loaded.vitals["respiratory-rate-sleep-summary"] ?? []
        )
          .filter((x) => x.civil_date === date)
          .map((x) => ({
            providerDate: date,
            sampledAt: x.sample_time_text,
            sourceKey: x.source_key,
            breathsPerMinute: num(x.breaths_per_minute),
            sourceFields: x.source_fields,
            association: "provider-date",
          })),
      };
    },
    async trends({ start, end, sources = {} }) {
      sleepRange(start, end);
      validateSleepSources(sources);
      const account = await repository.account(),
        preferences = await getPreferences();
      if (!account)
        return {
          days: [],
          months: [],
          preferences,
          analysisVersion: ANALYSIS_VERSION,
        };
      const { nights } = await load(
        account,
        shiftDate(start, -28),
        end,
        sources,
      );
      const days = nights
        .filter((n) => n.date >= start)
        .map((n) => ({
          date: n.date,
          sessionId: n.session?.id ?? null,
          mainSleepMinutes: n.session?.minutesAsleep ?? null,
          totalSleep: n.totalSleep,
          assessment: n.session
            ? assessNight({
                session: n.session,
                history: nights.filter((x) => x.session),
                goalMinutes: preferences.goalMinutes,
                date: n.date,
                physiology: n.physiology,
                timezone: account.timezone,
              })
            : null,
          physiology: n.physiology,
          provisional: n.session?.processed === false,
        }));
      const months = [...new Set(days.map((d) => d.date.slice(0, 7)))].map(
        (month) => {
          const entries = days.filter((d) => d.date.startsWith(month)),
            keys = [
              ...new Set(
                entries.flatMap((d) =>
                  Object.keys(d.assessment?.metrics ?? {}),
                ),
              ),
            ];
          const metrics = Object.fromEntries(
            keys.map((key) => {
              const measurements = entries
                .map((d) => d.assessment?.metrics[key])
                .filter((m) => m?.eligible && Number.isFinite(m.value));
              const methods = new Set(
                measurements.map((m) => `${m.sourceKey}:${m.method}`),
              );
              const values = measurements
                  .map((m) => m.value)
                  .sort((a, b) => a - b),
                count = values.length;
              let median = count
                ? (values[Math.floor((count - 1) / 2)] +
                    values[Math.ceil((count - 1) / 2)]) /
                  2
                : null;
              if (measurements[0]?.circular && count) {
                const angle = Math.atan2(
                  values.reduce((s, x) => s + Math.sin((x * Math.PI) / 720), 0),
                  values.reduce((s, x) => s + Math.cos((x * Math.PI) / 720), 0),
                );
                const anchor = ((angle * 720) / Math.PI + 1440) % 1440;
                const unwrapped = values
                  .map((x) => anchor + ((x - anchor + 2160) % 1440) - 720)
                  .sort((a, b) => a - b);
                median =
                  ((unwrapped[Math.floor((count - 1) / 2)] +
                    unwrapped[Math.ceil((count - 1) / 2)]) /
                    2 +
                    1440) %
                  1440;
              }
              return [
                key,
                {
                  value: methods.size > 1 ? null : median,
                  count,
                  unit: measurements[0]?.unit ?? null,
                  state:
                    methods.size > 1
                      ? "mixed-sources-or-methods"
                      : count
                        ? "available"
                        : "missing",
                },
              ];
            }),
          );
          const totals = entries
            .map((d) => d.totalSleep.minutesAsleep)
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
          return {
            month,
            recordedNights: entries.filter((d) => d.sessionId).length,
            calendarDays: entries.length,
            dates: entries.filter((d) => d.sessionId).map((d) => d.date),
            metrics,
            totalSleep: {
              medianMinutes: totals.length
                ? (totals[Math.floor((totals.length - 1) / 2)] +
                    totals[Math.ceil((totals.length - 1) / 2)]) /
                  2
                : null,
              count: totals.length,
            },
          };
        },
      );
      return {
        start,
        end,
        days,
        months,
        preferences,
        timezone: account.timezone,
        analysisVersion: ANALYSIS_VERSION,
        baselineRule: BASELINE_RULE,
        aggregation: {
          daily:
            "One longest non-nap sleep; total sleep is separately overlap-checked",
          monthly:
            "Median of usable same-source, same-method values; circular median for clock times",
          missing: "Missing nights remain null",
        },
      };
    },
  };
}
