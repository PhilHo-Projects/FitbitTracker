import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSummarySvg } from '../lib/exports/png.js';

test('PNG summary leaves clear space between table headers, rows, and footer', () => {
  const dailySummaries = Array.from({ length: 8 }, (_, index) => ({
    date: `2026-07-${String(9 + index).padStart(2, '0')}`,
    sleepDurationMinutes: 390 + index,
    heartRestingBpm: 60 + index,
    calorieTotalKcal: 2300 + index,
  }));
  const svg = buildSummarySvg({
    schemaVersion: '1.0.0',
    timezone: 'America/Toronto',
    range: { startDate: '2026-07-01', endDateExclusive: '2026-07-17' },
    dailySummaries,
    sleepStages: [],
    coverageWarnings: [],
  });

  assert.doesNotMatch(svg, /2026-07-09/);
  assert.doesNotMatch(svg, /2026-07-10/);
  assert.match(svg, /2026-07-11/);
  assert.match(svg, /y="700"/);
  assert.match(svg, /y="925"/);
  assert.match(svg, /y="972" class="muted"/);
});
