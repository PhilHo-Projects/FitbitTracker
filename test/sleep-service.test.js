import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { applyMigrations } from "../lib/db/migrations.js";
import { seedFixtures } from "../lib/db/fixtures.js";
import { createSleepService } from "../lib/sleep/service.js";

test("sleep reports select latest main sleep, include previous-evening tracks and distinguish missing dates", async () => {
  const pool = new (newDb({
    noAstCoverageCheck: true,
  }).adapters.createPg().Pool)();
  await applyMigrations(pool);
  await seedFixtures(pool, { anchorDate: "2026-09-08" });
  const service = createSleepService({ pool }),
    report = await service.report();
  assert.equal(report.date, "2026-09-08");
  assert.equal(report.assessment.metrics.duration.value, 379);
  assert.ok(report.tracks.spo2.samples.length > 300);
  assert.ok(
    report.tracks.spo2.samples.some(
      (x) => Date.parse(x.sampledAt) < Date.parse("2026-09-08T04:00:00Z"),
    ),
  );
  assert.equal(report.assessment.metrics.sleepingHr.eligible, false);
  assert.equal(
    report.availability["heart-rate-variability"].lastAttemptStatus,
    "not-synced",
  );
  const missing = await service.report({ date: "2026-08-01" });
  assert.equal(missing.session, null);
  const trends = await service.trends({
    start: "2026-08-25",
    end: "2026-09-09",
  });
  assert.equal(trends.days.length, 15);
  assert.equal(trends.days[0].mainSleepMinutes, null);
  assert.deepEqual(
    trends.days.at(-1).assessment.metrics.duration,
    report.assessment.metrics.duration,
  );
  await service.setPreferences({ goalMinutes: 450 });
  assert.equal(
    (await service.report({ includeTracks: false })).assessment.metrics.duration
      .goalDifferenceMinutes,
    -71,
  );
  assert.equal(JSON.stringify(report).includes("restfulness"), false);
  await pool.query('UPDATE sleep_sessions SET is_nap=true WHERE id=$1',[report.session.id]);
  const nap=await service.report({date:report.date,sessionId:report.session.id,includeTracks:false});
  assert.equal(nap.assessment.headline,'Recorded nap');
  assert.equal(nap.assessment.metrics.duration.goalDifferenceMinutes,null);
  assert.equal(nap.assessment.metrics.spo2.comparisonContext,'nap');
  await pool.end();
});
