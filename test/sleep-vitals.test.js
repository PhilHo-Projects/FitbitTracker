import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { applyMigrations } from "../lib/db/migrations.js";
import { createMetricWriter } from "../lib/db/metric-writer.js";
import { buildGoogleHealthRequest } from "../lib/jobs/google-health-request.js";
import {
  DEFAULT_SYNC_METRICS,
  planMetricWindows,
} from "../lib/jobs/planner.js";

const metrics = [
  "daily-heart-rate-variability",
  "heart-rate-variability",
  "daily-respiratory-rate",
  "respiratory-rate-sleep-summary",
  "daily-sleep-temperature-derivations",
];
test("all sleep vital streams are default, windowed, allowlisted list requests", () => {
  for (const metric of metrics) {
    assert.ok(DEFAULT_SYNC_METRICS.includes(metric), metric);
    const windows = planMetricWindows({
      metric,
      startDate: "2026-06-01",
      endDateExclusive: "2026-09-01",
    });
    assert.ok(
      windows.every(
        (x) =>
          x.operation === "list" &&
          x.days <= (metric.startsWith("daily-") ? 90 : 14),
      ),
    );
    assert.match(
      buildGoogleHealthRequest({ ...windows[0] }).url,
      /dataPoints\?/,
    );
  }
});

test("vitals preserve original records and update stable provider identities without deleting on empty fetch", async () => {
  const { normalizeSleepVitals } = await import(
    "../lib/metrics/sleep-vitals.js"
  );
  const memory = newDb({ noAstCoverageCheck: true });
  const pool = new (memory.adapters.createPg().Pool)();
  await applyMigrations(pool);
  const account = "75ce6554-70c7-48be-a688-d0079384fcb1";
  await pool.query(
    `INSERT INTO source_accounts(id,provider,provider_account_id) VALUES ($1,'google-health','test')`,
    [account],
  );
  const point = {
    name: "hrv-1",
    dataSource: { device: { displayName: "Air" } },
    heartRateVariability: {
      sampleTime: {
        physicalTime: "2026-09-08T03:50:00.123456789Z",
        utcOffset: "-14400s",
      },
      rootMeanSquareOfSuccessiveDifferencesMilliseconds: 42.25,
    },
  };
  const rows = normalizeSleepVitals("heart-rate-variability", {
    dataPoints: [point],
  });
  assert.equal(rows[0].civilDate, "2026-09-07");
  assert.equal(
    rows[0].sampledAt,
    point.heartRateVariability.sampleTime.physicalTime,
  );
  assert.deepEqual(rows[0].sourceFields, point);
  const writer = createMetricWriter(pool);
  await writer.upsertSleepVitals(account, "heart-rate-variability", rows);
  point.heartRateVariability.rootMeanSquareOfSuccessiveDifferencesMilliseconds = 43.25;
  await writer.upsertSleepVitals(
    account,
    "heart-rate-variability",
    normalizeSleepVitals("heart-rate-variability", { dataPoints: [point] }),
  );
  await writer.upsertSleepVitals(account, "heart-rate-variability", []);
  const saved = (await pool.query("SELECT * FROM sleep_hrv_samples")).rows;
  assert.equal(saved.length, 1);
  assert.equal(Number(saved[0].rmssd_ms), 43.25);
  assert.equal(saved[0].sample_time_text, rows[0].sampledAt);
  const unnamed = { ...point };
  delete unnamed.name;
  const noId = normalizeSleepVitals("heart-rate-variability", {
    dataPoints: [unnamed],
  });
  assert.equal(noId[0].providerId, null);
  await writer.upsertSleepVitals(account, "heart-rate-variability", noId);
  unnamed.heartRateVariability = {
    ...unnamed.heartRateVariability,
    rootMeanSquareOfSuccessiveDifferencesMilliseconds: 51,
  };
  await writer.upsertSleepVitals(
    account,
    "heart-rate-variability",
    normalizeSleepVitals("heart-rate-variability", { dataPoints: [unnamed] }),
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT rmssd_ms FROM sleep_hrv_samples WHERE provider_key=$1",
          [noId[0].providerKey],
        )
      ).rows[0].rmssd_ms,
    ),
    51,
  );
  await pool.end();
});
