import assert from "node:assert/strict";
import test from "node:test";

const night = (date = "2026-09-08") => ({
  id: date,
  date,
  startTime: `${date}T03:00:00Z`,
  endTime: `${date}T10:20:00Z`,
  startOffsetSeconds: -14400,
  endOffsetSeconds: -14400,
  minutesAsleep: 390,
  minutesAwake: 50,
  durationMinutes: 440,
  processed: true,
  type: "stages",
  sourceKey: "air",
  stages: [],
});

test("assessments use asleep duration, require fourteen previous observations, and never imply missing physiology is normal", async () => {
  const { assessNight } = await import("../lib/sleep/analysis.js");
  const report = assessNight({
    session: night(),
    history: [],
    goalMinutes: 420,
    date: "2026-09-08",
  });
  assert.equal(report.metrics.duration.value, 390);
  assert.equal(report.metrics.duration.goalDifferenceMinutes, -30);
  assert.match(report.headline, /Shorter than your goal/);
  assert.ok(report.notes.some((x) => x.includes("SpO₂")));
  assert.equal(report.metrics.awake.baseline.count, 0);
  assert.equal(report.findings.length, 1);
});

test("baseline excludes selected/future dates, handles midnight and zero spread", async () => {
  const { personalBaseline } = await import("../lib/sleep/analysis.js");
  const entries = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-08-${String(18 + i).padStart(2, "0")}`,
    value: i % 2 ? 10 : 1430,
    sourceKey: "air",
    method: "clock",
  }));
  const baseline = personalBaseline(entries, {
    date: "2026-09-01",
    sourceKey: "air",
    method: "clock",
    value: 0,
    circular: true,
  });
  assert.equal(baseline.count, 14);
  assert.ok(Math.abs(baseline.delta) < 1);
  assert.equal(baseline.comparison, "within");
  const fixed = personalBaseline(
    [
      ...entries.map((x) => ({ ...x, value: 5 })),
      { date: "2026-09-01", value: 999, sourceKey: "air", method: "clock" },
    ],
    { date: "2026-09-01", value: 10, sourceKey: "air", method: "clock" },
  );
  assert.equal(fixed.comparison, "flat");
  assert.equal(fixed.count, 14);
});

test("asleep minute coverage excludes awake samples and conflicts; overlaps make total unavailable", async () => {
  const { sleepingHeart, totalSleep } = await import(
    "../lib/sleep/analysis.js"
  );
  const session = {
    ...night(),
    stages: [
      {
        type: "light",
        startTime: "2026-09-08T03:00:30Z",
        endTime: "2026-09-08T03:05:00Z",
      },
    ],
  };
  const samples = [0, 1, 2, 3, 4].map((i) => ({
    sampledAt: `2026-09-08T03:0${i}:40Z`,
    beatsPerMinute: 60,
    sourceKey: "air",
  }));
  samples.push({
    sampledAt: "2026-09-08T04:00:00Z",
    beatsPerMinute: 100,
    sourceKey: "air",
  });
  assert.equal(sleepingHeart(session, samples, "air").value, 60);
  samples.push({ ...samples[0], beatsPerMinute: 80 });
  assert.equal(sleepingHeart(session, samples, "air").coverageFraction, 0.8);
  assert.equal(
    sleepingHeart(session, samples.slice(0, 3), "air").eligible,
    false,
  );
  assert.equal(
    totalSleep([session, { ...session, id: "overlap" }]).minutesAsleep,
    null,
  );
});

test("partial, provisional and cross-source nights do not manufacture eligible comparisons", async () => {
  const { assessNight, sessionMetrics, personalBaseline } = await import(
    "../lib/sleep/analysis.js"
  );
  const pending = assessNight({
    session: { ...night(), processed: false },
    history: [],
  });
  assert.equal(pending.findings.length, 0);
  assert.equal(pending.provisional, true);
  const partial = sessionMetrics({
    ...night(),
    stages: [
      {
        type: "light",
        startTime: "2026-09-08T03:10:00Z",
        endTime: "2026-09-08T03:30:00Z",
      },
    ],
  });
  assert.equal(partial.afterOnset.eligible, false);
  assert.equal(partial.initialAwake.value, null);
  assert.equal(partial.finalAwake.value, null);
  const entries = Array.from({ length: 28 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    value: 40,
    sourceKey: i < 13 ? "air" : "other",
    method: "daily",
  }));
  assert.equal(
    personalBaseline(entries, {
      date: "2026-08-29",
      sourceKey: "air",
      method: "daily",
      value: 40,
    }).comparison,
    "insufficient",
  );
  assert.equal(
    personalBaseline(entries, {
      date: "2026-08-29",
      sourceKey: "other",
      method: "sample-derived",
      value: 40,
    }).count,
    0,
  );
});
