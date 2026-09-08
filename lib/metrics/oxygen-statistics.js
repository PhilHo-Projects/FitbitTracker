import { floorDivide, oxygenInstantNanoseconds } from './oxygen-time.js';

const SECOND = 1_000_000_000n;
const MINUTE = 60n * SECOND;

export function selectOxygenWindow(samples, window) {
  if (!window) return samples;
  const start = oxygenInstantNanoseconds(window.startTime);
  const end = oxygenInstantNanoseconds(window.endTime);
  return samples.filter(({ sampledAt }) => {
    const time = oxygenInstantNanoseconds(sampledAt);
    return time >= start && time < end;
  });
}

function observations(samples) {
  if (new Set(samples.map(({ sourceKey }) => sourceKey)).size > 1) throw new Error('Select one oxygen source before summarizing');
  const groups = new Map();
  for (const sample of samples) {
    const time = oxygenInstantNanoseconds(sample.sampledAt);
    if (!groups.has(time)) groups.set(time, []);
    groups.get(time).push(sample);
  }
  let duplicateCount = 0;
  let conflictCount = 0;
  const ordered = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([time, rows]) => {
    const values = new Set(rows.map(({ percentage }) => percentage));
    duplicateCount += rows.length - values.size;
    if (values.size > 1) conflictCount++;
    return { time, sample: values.size === 1 ? rows[0] : null };
  });
  return { ordered, duplicateCount, conflictCount };
}

export function summarizeOxygenSamples(samples, window = null) {
  const { ordered, duplicateCount, conflictCount } = observations(selectOxygenWindow(samples, window));
  const valid = ordered.filter(({ sample }) => sample);
  const values = valid.map(({ sample }) => sample.percentage).sort((a, b) => a - b);
  const count = values.length;
  const minuteCount = new Set(valid.map(({ time }) => floorDivide(time, MINUTE))).size;
  const sleepMinutes = window ? Number(
    floorDivide(oxygenInstantNanoseconds(window.endTime) - 1n, MINUTE)
      - floorDivide(oxygenInstantNanoseconds(window.startTime), MINUTE) + 1n,
  ) : null;
  let gapCount = 0, longestGapSeconds = 0;
  for (let i = 1; i < valid.length; i++) {
    const seconds = Number(valid[i].time - valid[i - 1].time) / 1e9;
    if (seconds > 120) { gapCount++; longestGapSeconds = Math.max(longestGapSeconds, seconds); }
  }
  return {
    sampleCount: count, duplicateCount, conflictCount,
    averagePercentage: count ? values.reduce((a, b) => a + b, 0) / count : null,
    minimumPercentage: count ? values[0] : null,
    maximumPercentage: count ? values.at(-1) : null,
    medianPercentage: count ? (values[Math.floor((count - 1) / 2)] + values[Math.floor(count / 2)]) / 2 : null,
    firstSampleAt: valid[0]?.sample.sampledAt ?? null, lastSampleAt: valid.at(-1)?.sample.sampledAt ?? null,
    observedMinuteCount: minuteCount, sleepWindowMinuteCount: sleepMinutes,
    observedMinuteFraction: sleepMinutes > 0 ? minuteCount / sleepMinutes : null,
    gapCount, longestGapSeconds,
    qualityFlags: [...(conflictCount ? ['conflicting-observations'] : []), ...(duplicateCount ? ['duplicate-observations'] : []),
      ...(values.includes(0) ? ['provider-zero'] : []), ...(gapCount ? ['sample-gaps'] : [])],
  };
}

export function buildOxygenSegments(samples, { gapSeconds = 120, maxPoints = 1200 } = {}) {
  const { ordered, duplicateCount, conflictCount } = observations(samples);
  const segments = [];
  let current = null, previous = null;
  for (const { time, sample } of ordered) {
    if (!sample) { current = null; previous = null; continue; }
    if (!current || Number(time - previous) / 1e9 > gapSeconds) {
      current = []; segments.push(current);
    }
    current.push(sample); previous = time;
  }
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let reduced = false;
  // Never merge segments to satisfy a drawing budget: discontinuities are data.
  const bucketSize = total > maxPoints ? Math.ceil(total / Math.max(1, Math.floor(maxPoints / 4))) : 1;
  const reducedSegments = segments.map(segment => {
    if (bucketSize === 1) return segment;
    const keep = new Set();
    for (let start = 0; start < segment.length; start += bucketSize) {
      const end = Math.min(segment.length, start + bucketSize);
      let min = start, max = start;
      for (let i = start + 1; i < end; i++) {
        if (segment[i].percentage < segment[min].percentage) min = i;
        if (segment[i].percentage > segment[max].percentage) max = i;
      }
      for (const index of [start, min, max, end - 1]) keep.add(index);
    }
    reduced ||= keep.size < segment.length;
    return [...keep].sort((a, b) => a - b).map(index => segment[index]);
  });
  return { segments: reducedSegments, reduced, duplicateCount, conflictCount, gapSeconds };
}
