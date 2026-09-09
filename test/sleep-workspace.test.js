import assert from "node:assert/strict";
import test from "node:test";
import {
  readWorkspaceLocation,
  workspaceUrl,
} from "../public/sleep-navigation.js";
import {
  cursorReading,
  sleepDuration,
  recordedTime,
} from "../public/sleep-workspace.js";

test("workspace URLs restore sleep selection through Today, Settings and legacy links", () => {
  const selection = {
    date: "2026-11-01",
    sessionId: "11111111-1111-4111-8111-111111111111",
    sources: { hrv: "a".repeat(64) },
  };
  for (const view of ["sleep", "today", "settings", "more"]) {
    const location = new URL(
      workspaceUrl(view, "2026-11-02", selection),
      "https://example.test",
    );
    const restored = readWorkspaceLocation(location);
    assert.equal(restored.view, view);
    assert.deepEqual(restored.sleepSelection, selection);
  }
  assert.equal(
    readWorkspaceLocation(new URL("https://example.test/")).view,
    "sleep",
  );
  assert.equal(
    readWorkspaceLocation(new URL("https://example.test/#heart")).view,
    "heart",
  );
  assert.equal(
    readWorkspaceLocation(
      new URL("https://example.test/settings?google=connected"),
    ).view,
    "settings",
  );
});
test("cursor preserves original observation times, gaps and stage conflicts", () => {
  const sample = { sampledAt: "2026-11-01T03:30:40Z", value: 60 },
    report = {
      tracks: {
        stages: [
          {
            type: "light",
            startTime: "2026-11-01T03:30:00Z",
            endTime: "2026-11-01T03:31:00Z",
          },
        ],
        heart: { samples: [sample] },
        spo2: { samples: [] },
        hrv: { samples: [] },
      },
    };
  const read = cursorReading(report, Date.parse("2026-11-01T03:30:00Z"));
  assert.equal(read.measurements.heart.sampledAt, sample.sampledAt);
  assert.equal(read.measurements.spo2, null);
  report.tracks.hrv.samples.push({sampledAt:sample.sampledAt,value:null});
  assert.equal(cursorReading(report,Date.parse(sample.sampledAt)).measurements.hrv,null);
  assert.equal(
    cursorReading(report, Date.parse("2026-11-01T03:32:00Z")).measurements
      .heart,
    null,
  );
  report.tracks.stages.push({ ...report.tracks.stages[0], type: "awake" });
  assert.equal(
    cursorReading(report, Date.parse("2026-11-01T03:30:00Z")).stage,
    "Conflicting stages",
  );
  assert.equal(
    recordedTime(sample.sampledAt, -14400, "Pacific/Auckland"),
    "23:30",
  );
  assert.equal(sleepDuration(null), "Unavailable");
});
