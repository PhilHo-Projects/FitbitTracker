import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSleepInsights } from '../lib/sleep/insights.js';
import { createSleepSummary } from '../lib/sleep/summary.js';
import { copySleepReport, renderSleepPatterns } from '../public/sleep-insights-ui.js';
import { shiftDate } from '../lib/sleep/analysis.js';

test('dashboard and Markdown use identical comparisons, with private data excluded by default', () => {
  const date = '2026-09-13', metric = value => ({ value, eligible: true, sourceKey: 'source', method: 'method', unit: 'min' });
  const nights = Array.from({ length: 60 }, (_, i) => ({ date: shiftDate(date, -i), session: { id: String(i), processed: true },
    sessions: [], metrics: { duration: metric(i < 30 ? 450 : 420) } }));
  const privateEntries = [{ date, restfulness: 5, context: ['stress'], contextReviewed: true, note: '<script>PRIVATE</script>' }];
  const insights = buildSleepInsights({ date, days: 30, nights, checkIns: privateEntries, includeSleepCheckIns: false });
  const summary = createSleepSummary(insights);
  assert.equal(summary.summary, insights);
  assert.equal(insights.differences.duration.value, 30);
  assert.match(summary.markdown, /450 \| 420 \| \+30/);
  const html = renderSleepPatterns(insights);
  assert.match(html, /\+30 min/);
  assert.ok(!/data-pattern-private checked/.test(html));
  for (const serialized of [summary.markdown, JSON.stringify(summary), html]) assert.ok(!serialized.includes('PRIVATE'));
  assert.ok(!summary.markdown.includes('stress'));
  const included = createSleepSummary(buildSleepInsights({ date, days: 30, nights, checkIns: privateEntries }));
  assert.match(included.markdown, /5; stress/);
  assert.ok(!included.markdown.includes('PRIVATE'));
  assert.equal(included.summary.current.metrics.duration.required, 15);
});
test('clipboard rejection and unavailability both expose selectable report text', async () => {
  let fallback = null, copied = null;
  assert.equal(await copySleepReport('report', { clipboard: { writeText: async value => { copied = value; } }, fallback: () => assert.fail() }), true);
  assert.equal(copied, 'report');
  assert.equal(await copySleepReport('fallback report', { clipboard: { writeText: async () => { throw new Error('Denied'); } }, fallback: value => { fallback = value; } }), false);
  assert.equal(fallback, 'fallback report');
  assert.equal(await copySleepReport('unavailable', { fallback: value => { fallback = value; } }), false);
  assert.equal(fallback, 'unavailable');
});

test('Trends and Patterns separate period calculations from reviewed-factor comparisons', () => {
  const date = '2026-09-13';
  const nights = Array.from({ length: 60 }, (_, i) => ({
    date: shiftDate(date, -i), session: { id: String(i), processed: true }, sessions: [],
    metrics: { duration: { value: i < 7 ? 450 : 420, eligible: true, sourceKey: 'source', method: 'method', unit: 'min' } },
  }));
  const checkIns = nights.slice(0, 14).map((n, i) => ({ date: n.date, restfulness: i < 7 ? 5 : 1,
    context: i < 7 ? ['caffeine'] : [], contextReviewed: true, note: 'PRIVATE NOTE' }));
  const data = buildSleepInsights({ date, days: 30, nights, checkIns });
  const trends = renderSleepPatterns(data, { view: 'trends' });
  assert.match(trends, /sleep-comparison-table/);
  assert.doesNotMatch(trends, /data-pattern-factor/);
  const patterns = renderSleepPatterns(data, { view: 'patterns', factor: 'caffeine' });
  assert.doesNotMatch(patterns, /sleep-comparison-table/);
  assert.match(patterns, /data-pattern-factor="caffeine" aria-pressed="true"/);
  assert.match(patterns, /\+30 min/);
  assert.match(patterns, /7 usable nights/);
  assert.doesNotMatch(patterns, /PRIVATE NOTE/);
  checkIns[13].contextReviewed = false;
  const insufficient = renderSleepPatterns(buildSleepInsights({ date, days: 30, nights, checkIns }), { view: 'patterns', factor: 'caffeine' });
  assert.match(insufficient, /More check-ins needed/);
  assert.doesNotMatch(insufficient.split('<section class="lens-factor-detail">')[1].split('</section>')[0], /\+30 min/);
});
