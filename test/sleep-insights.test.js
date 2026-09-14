import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSleepInsights, clockConsistency } from '../lib/sleep/insights.js';
import { shiftDate } from '../lib/sleep/analysis.js';

const date = '2026-09-13';
function night(offset, value = 420, extra = {}) {
  const metric = (value, unit = 'min') => ({ value, unit, eligible: true, sourceKey: 'fixture-source', method: 'fixture-method' });
  return { date: shiftDate(date, -offset), session: { id: String(offset), processed: true, isNap: false }, sessions: [],
    metrics: { duration: metric(value), afterOnset: metric(20), efficiency: metric(90, '%'), bedtime: metric(offset % 2 ? 1430 : 10), wakeTime: metric(420) }, ...extra };
}
test('period comparisons enforce exact thresholds per metric and exclude missing or provisional nights', () => {
  const nights = Array.from({ length: 14 }, (_, i) => night(i, i < 7 ? 480 : 420));
  let result = buildSleepInsights({ date, days: 7, nights, goalMinutes: 450 });
  assert.equal(result.differences.duration.value, 60);
  assert.equal(result.current.metrics.goalMet.value, 100);
  assert.equal(result.previous.metrics.goalMet.value, 0);
  for (const i of [0, 1, 2]) nights[i].session.processed = false;
  result = buildSleepInsights({ date, days: 7, nights });
  assert.equal(result.current.metrics.duration.count, 4);
  assert.equal(result.differences.duration.value, 60);
  nights[3].metrics.duration.eligible = false;
  result = buildSleepInsights({ date, days: 7, nights });
  assert.equal(result.differences.duration.value, null);
  assert.equal(result.differences.duration.reason, 'insufficient-observations');
  assert.equal(result.nights.length, 7);
});
test('schedule consistency wraps midnight, while sources and methods must agree between periods', () => {
  assert.equal(clockConsistency([1430, 10]), 10);
  assert.equal(clockConsistency([1430, 0, 10]), 10);
  const nights = Array.from({ length: 14 }, (_, i) => night(i));
  nights[8].metrics.duration.sourceKey = 'another';
  const result = buildSleepInsights({ date, days: 7, nights });
  assert.equal(result.differences.duration.value, null);
  assert.equal(result.differences.duration.reason, 'mixed-sources-or-methods');
  assert.equal(result.differences.afterOnset.value, 0);
});
test('habit controls require explicit review, neutral restfulness is separate, and seven observations are required per group', () => {
  const nights = Array.from({ length: 30 }, (_, i) => night(i, i < 7 ? 450 : 420));
  const checkIns = nights.slice(0, 21).map((n, i) => ({ date: n.date, restfulness: i < 7 ? 5 : i < 14 ? 1 : 3,
    context: i < 7 ? ['caffeine'] : [], contextReviewed: i < 14, note: 'PRIVATE NOTE' }));
  delete checkIns[0].contextReviewed; // A legacy positive tag is still observed; absence of other tags remains unknown.
  let result = buildSleepInsights({ date, days: 30, nights, checkIns });
  const caffeine = result.checkInComparisons.factors.find(x => x.factor === 'caffeine');
  assert.equal(caffeine.metrics.duration.first.count, 7);
  assert.equal(caffeine.metrics.duration.second.count, 7);
  assert.equal(caffeine.metrics.duration.difference.value, 30);
  assert.equal(result.checkInComparisons.restfulness.neutralDates.length, 7);
  assert.equal(result.checkInComparisons.restfulness.metrics.duration.difference.value, 30);
  assert.ok(!JSON.stringify(result).includes('PRIVATE NOTE'));
  checkIns[13].contextReviewed = false;
  result = buildSleepInsights({ date, days: 30, nights, checkIns });
  assert.equal(result.checkInComparisons.factors.find(x => x.factor === 'caffeine').metrics.duration.difference.value, null);
});
test('90-day comparisons require 45 usable nights and naps never enter main-sleep comparisons', () => {
  const nights = Array.from({ length: 180 }, (_, i) => night(i));
  for (const n of nights.slice(0, 46)) n.session.isNap = true;
  const result = buildSleepInsights({ date, days: 90, nights });
  assert.equal(result.current.metrics.duration.required, 45);
  assert.equal(result.current.metrics.duration.count, 44);
  assert.equal(result.differences.duration.value, null);
});
