import { hashSourceMetadata } from "../metrics/source-metadata.js";
import { SLEEP_VITALS } from "../metrics/sleep-vitals.js";
import { oxygenFetchStatus } from "../db/oxygen-repository.js";
import { shiftDate } from "./analysis.js";
import { oxygenInstantNanoseconds } from '../metrics/oxygen-time.js';

export const num = (value) => (value == null ? null : Number(value));
export const iso = (value) => (value ? new Date(value).toISOString() : null);
export const day = (value) =>
  typeof value === "string" ? value.slice(0, 10) : iso(value)?.slice(0, 10);
const sourceOf = (row) =>
  row.source_fields?.dataSource ??
  (Object.keys(row.device ?? {}).length ? { device: row.device } : {});
export function mapSleepSession(row, stages) {
  const stored = row.source_fields ?? {},
    original = stored.sourceFields ?? {};
  const metadata = original.sleep?.metadata ?? stored.metadata ?? {};
  const sourceMetadata = original.dataSource ??
    stored.source ?? { device: row.device ?? {} };
  const latency =
    stored.normalizationVersion >= 2 || Number(row.time_to_sleep_seconds) !== 0
      ? num(row.time_to_sleep_seconds)
      : null;
  const stageSummary = {};
  for (const stage of stages.filter((x) => x.sleep_session_id === row.id)) {
    stageSummary[stage.stage_type] ??= { minutes: 0, episodes: 0 };
    stageSummary[stage.stage_type].minutes +=
      Number(stage.duration_seconds) / 60;
    stageSummary[stage.stage_type].episodes++;
  }
  return {
    id: row.id,
    providerKey: row.provider_key,
    providerId: row.provider_id,
    date: day(row.civil_date_text ?? row.civil_date),
    stageSummary,
    startTime: original.sleep?.interval?.startTime ?? iso(row.start_time),
    endTime: original.sleep?.interval?.endTime ?? iso(row.end_time),
    startOffsetSeconds: num(row.start_offset_seconds),
    endOffsetSeconds: num(row.end_offset_seconds),
    type: row.sleep_type,
    isNap: row.is_nap,
    asleepDerivation: stored.asleepDerivation ?? "legacy-unspecified",
    awakeDerivation: stored.awakeDerivation ?? "legacy-unspecified",
    durationMinutes:
      (Date.parse(row.end_time) - Date.parse(row.start_time)) / 60000,
    minutesAsleep:
      num(row.asleep_seconds) === null ? null : Number(row.asleep_seconds) / 60,
    efficiency: num(row.efficiency),
    minutesAwake:
      num(row.awake_seconds) === null ? null : Number(row.awake_seconds) / 60,
    timeToSleepMinutes: latency === null ? null : latency / 60,
    minutesAfterWakeUp:
      stored.normalizationVersion >= 2 ? stored.minutesAfterWakeUp : null,
    processed: metadata.processed ?? null,
    metadata,
    sourceKey: hashSourceMetadata(sourceMetadata),
    sourceMetadata,
    outOfBedSegments:
      original.sleep?.outOfBedSegments ?? stored.outOfBedSegments ?? [],
    sourceFields: stored,
    updatedAt: iso(row.updated_at),
    stages: stages
      .filter((x) => x.sleep_session_id === row.id)
      .map((x) => ({
        type: x.stage_type,
        startTime: x.source_fields?.startTime ?? iso(x.start_time),
        endTime: x.source_fields?.endTime ?? iso(x.end_time),
        sourceFields: x.source_fields,
      })),
  };
}
export function mapHeartSample(row) {
  const sourceMetadata = row.source_metadata ?? sourceOf(row);
  return {
    sampledAt:
      row.source_fields?.heartRate?.sampleTime?.physicalTime ??
      iso(row.sampled_at),
    utcOffsetSeconds: num(row.utc_offset_seconds),
    beatsPerMinute: num(row.beats_per_minute),
    sourceKey: hashSourceMetadata(sourceMetadata),
    sourceMetadata,
    providerId: row.provider_id,
    sourceFields: row.source_fields,
  };
}
export function createSleepRepository(pool) {
  const memory = pool.constructor?.name === "MemPg";
  const civilProjection = memory ? "civil_date" : "civil_date::text";
  async function account() {
    return (
      (
        await pool.query(
          "SELECT id,timezone FROM source_accounts ORDER BY created_at LIMIT 1",
        )
      ).rows[0] ?? null
    );
  }
  async function sessions(accountId, start, end) {
    const [records, stages] = await Promise.all([
      pool.query(
        `SELECT *, ${civilProjection} AS civil_date_text FROM sleep_sessions WHERE source_account_id=$1 AND civil_date >= $2 AND civil_date < $3 ORDER BY civil_date, duration_seconds DESC, id`,
        [accountId, start, end],
      ),
      pool.query(
        `SELECT st.* FROM sleep_stages st JOIN sleep_sessions s ON s.id=st.sleep_session_id WHERE s.source_account_id=$1 AND s.civil_date >= $2 AND s.civil_date < $3 ORDER BY st.start_time`,
        [accountId, start, end],
      ),
    ]);
    return records.rows.map((row) => mapSleepSession(row, stages.rows));
  }
  async function vitalRows(accountId, start, end) {
    const tables = [
      ...Object.entries(SLEEP_VITALS)
        .filter(([, v]) => v.daily || v.table === "sleep_respiratory_summaries")
        .map(([metric, v]) => [metric, v.table]),
      ["daily-oxygen-saturation", "oxygen_saturation_daily_summaries"],
    ];
    return Object.fromEntries(
      await Promise.all(
        tables.map(async ([metric, table]) => [
          metric,
          (
            await pool.query(
              `SELECT *, ${civilProjection} AS civil_date_text FROM ${table} WHERE source_account_id=$1 AND civil_date >= $2 AND civil_date < $3 ORDER BY civil_date,provider_key`,
              [accountId, start, end],
            )
          ).rows.map((row) => ({
            ...row,
            civil_date: day(row.civil_date_text ?? row.civil_date),
          })),
        ]),
      ),
    );
  }
  async function heartBins(accountId, start, end, sleepSessions) {
    if (!sleepSessions.length) return [];
    if (memory) {
      const earliest = sleepSessions.map((s) => s.startTime).sort()[0],
        latest = sleepSessions
          .map((s) => s.endTime)
          .sort()
          .at(-1);
      const raw = (
        await pool.query(
          "SELECT * FROM heart_rate_samples WHERE source_account_id=$1 AND sampled_at >= $2 AND sampled_at < $3",
          [accountId, earliest, latest],
        )
      ).rows.map(mapHeartSample);
      return sleepSessions.flatMap((s) =>
        raw
          .filter(
            (x) =>
              Date.parse(x.sampledAt) >= Date.parse(s.startTime) &&
              Date.parse(x.sampledAt) < Date.parse(s.endTime),
          )
          .map((x) => ({ ...x, sessionId: s.id })),
      );
    }
    // Only read minute aggregates over identified asleep segments, rather than a year of raw samples.
    // Conflicting values at the same timestamp/source do not contribute to coverage or means.
    const rows = (
      await pool.query(
        `WITH observations AS (
      SELECT s.id AS session_id, h.sampled_at,
        COALESCE(h.source_fields->'dataSource', CASE WHEN h.device <> '{}'::jsonb THEN jsonb_build_object('device',h.device) ELSE '{}'::jsonb END) AS source_metadata,
        MIN(h.beats_per_minute) AS bpm
      FROM sleep_sessions s JOIN heart_rate_samples h ON h.source_account_id=s.source_account_id AND h.sampled_at>=s.start_time AND h.sampled_at<s.end_time
      WHERE s.source_account_id=$1 AND s.civil_date >= $2 AND s.civil_date < $3
        AND EXISTS (SELECT 1 FROM sleep_stages st WHERE st.sleep_session_id=s.id
          AND st.stage_type IN ('light','deep','rem','asleep') AND h.sampled_at>=st.start_time AND h.sampled_at<st.end_time)
      GROUP BY s.id,h.sampled_at,COALESCE(h.source_fields->'dataSource', CASE WHEN h.device <> '{}'::jsonb THEN jsonb_build_object('device',h.device) ELSE '{}'::jsonb END)
      HAVING COUNT(DISTINCT h.beats_per_minute)=1
    ) SELECT session_id,source_metadata,MIN(sampled_at) AS sampled_at,AVG(bpm) AS beats_per_minute
      FROM observations GROUP BY session_id,source_metadata,date_trunc('minute',sampled_at) ORDER BY sampled_at`,
        [accountId, start, end],
      )
    ).rows;
    return rows.map((row) => ({
      ...mapHeartSample(row),
      sessionId: row.session_id,
    }));
  }
  return {
    account,
    sessions,
    vitalRows,
    heartBins,
    async dates(accountId) {
      return (
        await pool.query(
          "SELECT civil_date FROM sleep_sessions WHERE source_account_id=$1 AND is_nap=false GROUP BY civil_date ORDER BY civil_date DESC",
          [accountId],
        )
      ).rows.map((x) => day(x.civil_date));
    },
    async preferences(accountId) {
      const row = (
        await pool.query(
          "SELECT goal_minutes FROM sleep_preferences WHERE source_account_id=$1",
          [accountId],
        )
      ).rows[0];
      return { goalMinutes: row ? Number(row.goal_minutes) : 420 };
    },
    async savePreferences(accountId, goalMinutes) {
      await pool.query(
        "INSERT INTO sleep_preferences(source_account_id,goal_minutes) VALUES($1,$2) ON CONFLICT(source_account_id) DO UPDATE SET goal_minutes=EXCLUDED.goal_minutes,updated_at=CURRENT_TIMESTAMP",
        [accountId, goalMinutes],
      );
      return { goalMinutes };
    },
    async tracks(accountId, session) {
      // PostgreSQL projects nanosecond provider timestamps to microseconds. Bracket the
      // query, then apply the exact half-open window to the preserved source timestamps.
      const startNs=oxygenInstantNanoseconds(session.startTime), endNs=oxygenInstantNanoseconds(session.endTime);
      const params = [accountId, new Date(Date.parse(session.startTime)-1).toISOString(), new Date(Date.parse(session.endTime)+1).toISOString()];
      const inside=point=>{const instant=oxygenInstantNanoseconds(point.sampledAt);return instant>=startNs&&instant<endNs;};
      const [hr, o2, hrv] = await Promise.all(
        [
          "heart_rate_samples",
          "oxygen_saturation_samples",
          "sleep_hrv_samples",
        ].map((table) =>
          pool.query(
            `SELECT * FROM ${table} WHERE source_account_id=$1 AND sampled_at >= $2 AND sampled_at < $3 ORDER BY sampled_at LIMIT 50001`,
            params,
          ),
        ),
      );
      const point = (row, field) => ({
        sampledAt: row.sample_time_text,
        utcOffsetSeconds: num(row.utc_offset_seconds),
        value: num(row[field]),
        sourceKey: row.source_key,
        sourceMetadata: row.source_metadata,
        providerId: row.provider_id,
        sourceFields: row.source_fields,
      });
      return {
        heart: hr.rows.slice(0, 50000).map((row) => {
          const x = mapHeartSample(row);
          return { ...x, value: x.beatsPerMinute };
        }).filter(inside),
        spo2: o2.rows.slice(0, 50000).map((row) => point(row, "percentage")).filter(inside),
        hrv: hrv.rows.slice(0, 50000).map((row) => point(row, "rmssd_ms")).filter(inside),
        truncated: {
          heart: hr.rows.length > 50000,
          spo2: o2.rows.length > 50000,
          hrv: hrv.rows.length > 50000,
        },
      };
    },
    async availability(accountId, date) {
      const metrics = [
        "sleep",
        "heart-rate",
        "oxygen-saturation",
        "daily-oxygen-saturation",
        ...Object.keys(SLEEP_VITALS),
      ];
      const rows = (
        await pool.query(
          `SELECT c.*,j.created_at AS job_created_at FROM sync_chunks c JOIN sync_jobs j ON j.id=c.sync_job_id WHERE j.source_account_id=$1 AND c.start_date < $3 AND c.end_date_exclusive > $2 ORDER BY c.created_at DESC`,
          [accountId, shiftDate(date, -1), shiftDate(date, 1)],
        )
      ).rows;
      return Object.fromEntries(
        metrics.map((metric) => {
          const matches = rows.filter((x) => x.metric === metric),
            sample = [
              "heart-rate",
              "oxygen-saturation",
              "heart-rate-variability",
              "respiratory-rate-sleep-summary",
            ].includes(metric);
          const fetch = oxygenFetchStatus(matches, {
            startDate: sample ? shiftDate(date, -1) : date,
            endDateExclusive: shiftDate(date, 1),
          });
          const latest = matches[0];
          return [
            metric,
            {
              ...fetch,
              errorCode: fetch.errorCode ? "SLEEP_METRIC_SYNC_FAILED" : null,
              permissionDenied:
                latest?.status === "failed" &&
                /permission|HTTP 403|HTTP 401/i.test(latest.last_error ?? ""),
              observationCoverage: null,
              reliability:
                "Provider-specific; fetch completion is not a quality rating",
            },
          ];
        }),
      );
    },
  };
}
