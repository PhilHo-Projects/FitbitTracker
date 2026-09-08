import assert from 'node:assert/strict';
import test from 'node:test';
import { oxygenAxis, renderOxygenNight, renderOxygenTrend, oxygenStatusMessage, renderOxygenCard } from '../public/oxygen-ui.js';

test('oxygen presentation keeps zero visible and separates confidence from observed extrema', () => {
  assert.deepEqual(oxygenAxis([96, 99]), { minimum: 85, maximum: 100 });
  assert.deepEqual(oxygenAxis([0, 96]), { minimum: 0, maximum: 100 });
  const day = { date: '2026-09-07', dataState: 'summary-only', dailySummary: { averagePercentage: 0, lowerBoundPercentage: null, upperBoundPercentage: null },
    sampleSummary: { sampleCount: 0 }, samples: [], sampleSources: [], dailySources: [], plot: { segments: [] }, sync: {}, window: { kind: 'civil-day' } };
  const html = renderOxygenNight(day);
  assert.match(html, /0\.0%/); assert.match(html, /Google daily summary/); assert.match(html, /confidence/i);
  assert.ok(!html.includes('NaN')); assert.ok(!html.includes('undefined'));
  assert.match(renderOxygenCard(day), /0\.0%/);
});

test('source labels are escaped and ambiguous rows are retained without a fabricated summary', () => {
  const html = renderOxygenNight({ date: '2026-09-07', dataState: 'source-selection-required', dailySummary: null,
    dailyCandidates: [{ averagePercentage: 94, providerId: '<img src=x>', lowerBoundPercentage: 90, upperBoundPercentage: 99 }],
    sampleSources: [{ key: 'a'.repeat(64), label: '<script>alert(1)</script>', recordCount: 1 }], dailySources: [], samples: [], sampleSummary: {}, plot: { segments: [] }, sync: {}, window: { kind: 'civil-day' } });
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x>'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /Choose a source/);
});

test('failed fetch remains distinct from saved data and daily trends keep missing dates', () => {
  assert.match(oxygenStatusMessage({ dataState: 'empty', sync: {} }), /No SpO₂ readings returned/);
  assert.match(oxygenStatusMessage({ dataState: 'not-synced', sync: {} }), /not been fetched completely/);
  assert.match(oxygenStatusMessage({ dataState: 'ready', sync: { intraday: { lastAttemptStatus: 'failed' } } }), /sync failed/);
  assert.match(oxygenStatusMessage({ dataState: 'empty', sync: { intraday: { lastAttemptStatus: 'running' } } }), /sync is running/);
  assert.match(oxygenStatusMessage({ dataState: 'empty', sync: { daily: { lastAttemptStatus: 'queued' } } }), /sync is queued/);
  assert.match(oxygenStatusMessage({ dataState: 'empty', qualityFlags: ['daily-ambiguous'], sync: {} }), /Multiple provider daily records/);
  assert.match(oxygenStatusMessage({ dataState: 'empty', sampleSummary: { sampleCount: 0, conflictCount: 2 }, sync: {} }), /conflict/i);
  const html = renderOxygenTrend({ days: [
    { date: '2026-09-01', dailySummary: { averagePercentage: 96 } },
    { date: '2026-09-02', dailySummary: null },
    { date: '2026-09-03', dailySummary: { averagePercentage: 98 } },
  ], dailySources: [], periodSummary: { averageDailyPercentage: 97, daysWithSummary: 2, requestedDays: 3 }, sync: {} });
  assert.match(html, /2 of 3 days/); assert.match(html, /2026-09-02/); assert.ok(!html.includes('NaN'));
  assert.equal((html.match(/class="oxygen-line"/g) ?? []).length, 2);
});

test('oxygen detail shows recorded dates and distinguishes reading freshness from fetch freshness', () => {
  const sample = { sampledAt: '2026-09-07T03:17:00Z', percentage: 96.4, utcOffsetSeconds: -14400 };
  const html = renderOxygenNight({ date: '2026-09-07', dataState: 'samples-only', samples: [sample],
    newestSampleAt: sample.sampledAt, plot: { segments: [[sample]] },
    window: { kind: 'sleep-session', startTime: sample.sampledAt, endTime: '2026-09-07T09:54:00Z' },
    sleepSession: { startOffsetSeconds: -14400, endOffsetSeconds: -14400, stages: [] },
    sync: { intraday: { lastAttemptStatus: 'running', lastAttemptAt: '2026-09-07T12:00:00Z',
      lastSuccessfulFetchAt: '2026-09-07T10:00:00Z', fetchComplete: true } } });
  assert.match(html, /2026-09-06 23:17 UTC−04:00/);
  assert.match(html, /2026-09-07 05:54 UTC−04:00/);
  assert.match(html, /Newest stored reading/);
  assert.match(html, /2026-09-07T03:17:00Z/);
  assert.match(html, /Last completed fetch/);
  assert.match(html, /2026-09-07T10:00:00Z/);
  assert.match(html, /2026-09-07T12:00:00Z/);
});
