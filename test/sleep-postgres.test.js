import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { applyMigrations } from "../lib/db/migrations.js";
import { createMetricWriter } from "../lib/db/metric-writer.js";
import { normalizeSleepResponse } from "../lib/sleep-normalizer.js";
import { normalizeSleepVitals } from "../lib/metrics/sleep-vitals.js";
import { createSleepService } from "../lib/sleep/service.js";
import { createSleepCheckInRepository } from "../lib/sleep/check-ins.js";
import { createJournalCipher } from "../lib/journal/crypto.js";
import { createAnalysisDatasetService } from "../lib/exports/dataset.js";

test(
  "PostgreSQL sleep migration, offset timestamps, minute coverage, corrections and export evidence",
  { skip: !process.env.PG_INTEGRATION_URL },
  async () => {
    const pool = new pg.Pool({
        connectionString: process.env.PG_INTEGRATION_URL,
      }),
      schema = `sleep_test_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const scoped = {
      async connect() {
        const c = await pool.connect();
        await c.query(`SET search_path TO "${schema}"`);
        await c.query("SET TIME ZONE 'Pacific/Auckland'");
        return c;
      },
      async query(...args) {
        const c = await this.connect();
        try {
          return await c.query(...args);
        } finally {
          c.release();
        }
      },
    };
    try {
      await applyMigrations(pool, { schema });
      assert.deepEqual(await applyMigrations(pool, { schema }), []);
      const account = randomUUID();
      await scoped.query(
        "INSERT INTO source_accounts(id,provider,provider_account_id,timezone) VALUES($1,'google-health','sleep-pg','America/New_York')",
        [account],
      );
      const writer = createMetricWriter(scoped),
        dataSource = { device: { displayName: "Test Air" } };
      const start = "2026-11-01T03:30:00Z",
        end = "2026-11-01T10:50:00Z";
      const point = {
        name: "main",
        dataSource,
        sleep: {
          type: "STAGES",
          metadata: { processed: true, stagesStatus: "SUCCEEDED" },
          interval: {
            startTime: start,
            endTime: end,
            startUtcOffset: "-14400s",
            endUtcOffset: "-18000s",
          },
          summary: {
            minutesInSleepPeriod: "440",
            minutesAsleep: "390",
            minutesAwake: "50",
          },
          stages: [
            {
              type: "LIGHT",
              startTime: start,
              endTime: "2026-11-01T10:00:00Z",
            },
            { type: "AWAKE", startTime: "2026-11-01T10:00:00Z", endTime: end },
          ],
          outOfBedSegments: [
            {
              startTime: "2026-11-01T10:05:00Z",
              endTime: "2026-11-01T10:10:00Z",
            },
          ],
        },
      };
      const nap = {
        ...point,
        name: "nap",
        sleep: {
          ...point.sleep,
          metadata: { processed: true, nap: true },
          interval: {
            startTime: "2026-11-01T18:00:00Z",
            endTime: "2026-11-01T18:30:00Z",
            startUtcOffset: "-18000s",
            endUtcOffset: "-18000s",
          },
          summary: {
            minutesAsleep: "25",
            minutesAwake: "5",
            minutesToFallAsleep: "0",
          },
          stages: [],
        },
      };
      await writer.upsertSleepSessions(
        account,
        normalizeSleepResponse({ dataPoints: [point, nap] }).sessions,
      );
      // Generate real SQL samples crossing the previous civil evening and the DST clock change.
      await scoped.query(
        `INSERT INTO heart_rate_samples(id,source_account_id,provider_key,civil_date,sampled_at,beats_per_minute,source_fields)
      SELECT md5('hr'||g::text)::uuid,$1,'hr'||g::text,'2026-11-01'::date,$2::timestamptz+g*interval '1 minute',60,$3::jsonb FROM generate_series(0,389) g`,
        [account, start, JSON.stringify({ dataSource })],
      );
      await writer.upsertSleepVitals(
        account,
        "heart-rate-variability",
        normalizeSleepVitals("heart-rate-variability", {
          dataPoints: [
            {
              dataSource,
              heartRateVariability: {
                sampleTime: {
                  physicalTime: "2026-11-01T03:40:00.123456789Z",
                  utcOffset: "-14400s",
                },
                rootMeanSquareOfSuccessiveDifferencesMilliseconds: 42.125,
              },
            },
            ...['2026-11-01T10:49:59.999999999Z','2026-11-01T10:50:00Z'].map(physicalTime=>({dataSource,heartRateVariability:{sampleTime:{physicalTime,utcOffset:'-18000s'},rootMeanSquareOfSuccessiveDifferencesMilliseconds:40}})),
          ],
        }),
      );
      const service = createSleepService({ pool: scoped }),
        report = await service.report();
      assert.equal(report.date, "2026-11-01");
      assert.equal(report.sessions.length, 2);
      assert.equal(report.session.timeToSleepMinutes, null);
      assert.equal(report.session.outOfBedSegments.length, 1);
      assert.equal(
        report.assessment.metrics.duration.goalDifferenceMinutes,
        -30,
      );
      assert.equal(report.assessment.metrics.bedtime.value, 1410);
      assert.equal(report.assessment.metrics.wakeTime.value, 350);
      assert.equal(report.assessment.metrics.sleepingHr.value, 60);
      assert.equal(report.assessment.metrics.sleepingHr.coverageFraction, 1);
      assert.equal(
        report.tracks.hrv.samples[0].sampledAt,
        "2026-11-01T03:40:00.123456789Z",
      );
      assert.equal(report.totalSleep.minutesAsleep, 415);
      assert.equal(report.tracks.hrv.samples.length, 2);
      assert.equal(report.tracks.hrv.samples.at(-1).sampledAt,'2026-11-01T10:49:59.999999999Z');
      assert.equal(
        (
          await service.report({
            date: report.date,
            sessionId: report.sessions.find((s) => s.isNap).id,
          })
        ).session.timeToSleepMinutes,
        0,
      );
      point.sleep.summary.minutesToFallAsleep = "0";
      await writer.upsertSleepSessions(
        account,
        normalizeSleepResponse({ dataPoints: [point] }).sessions,
      );
      assert.equal(
        (await service.report({ includeTracks: false })).session
          .timeToSleepMinutes,
        0,
      );
      const checkIns = createSleepCheckInRepository(
        scoped,
        createJournalCipher(`1:${randomBytes(32).toString("base64")}`),
      );
      await checkIns.put("2026-11-01", {
        restfulness: 4,
        note: "private sleep note",
      });
      const datasets = createAnalysisDatasetService({
        pool: scoped,
        sleepCheckIns: checkIns,
      });
      const range = { startDate: "2026-11-01", endDateExclusive: "2026-11-02" };
      const exported = await datasets.buildAnalysisDataset(range, ["sleep"]);
      assert.equal(exported.sleepCheckInsIncluded, false);
      assert.equal(
        JSON.stringify(exported).includes("private sleep note"),
        false,
      );
      assert.equal(
        exported.sleepAnalysis.days[0].assessment.metrics.duration.value,
        390,
      );
      assert.equal(exported.dailySummaries[0].sleepAsleepMinutes, 390);
      const withPrivate = await datasets.buildAnalysisDataset(
        range,
        ["sleep"],
        "analysis",
        false,
        { includeSleepCheckIns: true },
      );
      assert.equal(withPrivate.sleepCheckIns[0].note, "private sleep note");
    } finally {
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      await pool.end();
    }
  },
);
