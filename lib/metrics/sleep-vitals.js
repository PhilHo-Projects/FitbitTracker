import {
  hashSourceMetadata,
  canonicalizeSourceMetadata,
} from "./source-metadata.js";
import { parseOxygenTime, oxygenCivilDate } from "./oxygen-time.js";

// Internal schema constants; provider input never supplies SQL identifiers.
export const SLEEP_VITALS = {
  "daily-heart-rate-variability": {
    table: "sleep_hrv_daily",
    property: "dailyHeartRateVariability",
    daily: true,
    fields: {
      rmssd_ms: "averageHeartRateVariabilityMilliseconds",
      non_rem_bpm: "nonRemHeartRateBeatsPerMinute",
      entropy: "entropy",
      deep_rmssd_ms:
        "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds",
    },
  },
  "heart-rate-variability": {
    table: "sleep_hrv_samples",
    property: "heartRateVariability",
    daily: false,
    fields: {
      rmssd_ms: "rootMeanSquareOfSuccessiveDifferencesMilliseconds",
      sdnn_ms: "standardDeviationMilliseconds",
    },
  },
  "daily-respiratory-rate": {
    table: "sleep_respiratory_daily",
    property: "dailyRespiratoryRate",
    daily: true,
    fields: { breaths_per_minute: "breathsPerMinute" },
  },
  "respiratory-rate-sleep-summary": {
    table: "sleep_respiratory_summaries",
    property: "respiratoryRateSleepSummary",
    daily: false,
    fields: {
      breaths_per_minute: "fullSleepStats.breathsPerMinute",
      standard_deviation: "fullSleepStats.standardDeviation",
      signal_to_noise: "fullSleepStats.signalToNoise",
    },
  },
  "daily-sleep-temperature-derivations": {
    table: "sleep_temperature_daily",
    property: "dailySleepTemperatureDerivations",
    daily: true,
    fields: {
      temperature_celsius: "nightlyTemperatureCelsius",
      baseline_celsius: "baselineTemperatureCelsius",
      relative_stddev_celsius: "relativeNightlyStddev30dCelsius",
    },
  },
};
export const SLEEP_VITAL_METRICS = Object.keys(SLEEP_VITALS);
export const sleepVitalFilter = (metric) =>
  `${metric.replaceAll("-", "_")}.${SLEEP_VITALS[metric].daily ? "date" : "sample_time.civil_time"}`;

export function normalizeSleepVitals(metric, payload) {
  const spec = SLEEP_VITALS[metric];
  if (!spec) throw new Error("Unsupported sleep vital");
  const rows = new Map();
  const points = payload?.dataPoints;
  if (points != null && !Array.isArray(points))
    throw new Error("Invalid sleep vital response");
  for (const point of points ?? []) {
    const value = point[spec.property];
    const providerId = point.name ?? point.dataPointName ?? null;
    if (!value) throw new Error("Invalid sleep vital record");
    const time = spec.daily
      ? { civilDate: oxygenCivilDate(value.date) }
      : parseOxygenTime(value.sampleTime);
    const sourceKey = hashSourceMetadata(point.dataSource ?? {});
    // Google omits names on several list-only streams. Source + civil date or exact instant is stable across corrections.
    const providerKey =
      providerId ??
      `${metric}:${sourceKey}:${spec.daily ? time.civilDate : time.epochNanoseconds.toString()}`;
    const fields = Object.fromEntries(
      Object.entries(spec.fields).map(([column, field]) => {
        const raw = field.split(".").reduce((v, k) => v?.[k], value);
        const number = raw == null ? null : Number(raw);
        if (
          number !== null &&
          (!Number.isFinite(number) ||
            (column !== "temperature_celsius" &&
              column !== "baseline_celsius" &&
              column !== "entropy" &&
              column !== "signal_to_noise" &&
              number < 0))
        )
          throw new Error("Invalid sleep vital value");
        return [column, number];
      }),
    );
    const previous = rows.get(providerKey);
    if (
      previous &&
      JSON.stringify(canonicalizeSourceMetadata(previous.sourceFields)) !==
        JSON.stringify(canonicalizeSourceMetadata(point))
    )
      throw new Error("Conflicting sleep vital identity");
    rows.set(providerKey, {
      providerKey,
      providerId,
      civilDate: time.civilDate,
      sampledAt: time.sampledAt ?? null,
      utcOffsetSeconds: time.utcOffsetSeconds ?? null,
      sourceKey,
      sourceMetadata: point.dataSource ?? {},
      sourceFields: point,
      ...fields,
    });
  }
  return [...rows.values()];
}
