const text = value => String(value ?? 'Unknown').replaceAll('|', '\\|').replaceAll('\n', ' ');
const value = number => Number.isFinite(number) ? String(Number(number.toFixed(1))) : 'Unavailable';
const reason = code => ({ 'insufficient-observations': 'Not enough usable nights', 'mixed-sources-or-methods': 'Sources or methods differ' }[code] ?? code ?? '');

export function createSleepSummary(insights) {
  const { current, previous } = insights;
  const lines = ['# Sleep analysis report', '',
    `Wake dates: ${current.startDate} through ${insights.date} (${insights.days} days). Timezone: ${text(insights.timezone)}.`,
    `Previous period: ${previous.startDate} through ${new Date(Date.parse(previous.endDateExclusive) - 86400000).toISOString().slice(0, 10)}.`,
    `Chosen sleep goal: ${insights.goalMinutes} minutes. Main sleep only; naps listed separately. Goal percentage is calculated among usable main-sleep nights.`,
    `Source selections: ${Object.keys(insights.sources).length ? Object.entries(insights.sources).map(([key, source]) => `${key}=${source}`).join('; ') : 'Automatic when unambiguous; source conflicts excluded'}.`,
    '', '## Period comparisons', '', '| Measurement | Current | Previous | Change | Usable nights current / previous |',
    '| --- | ---: | ---: | --- | --- |'];
  for (const [key, m] of Object.entries(current.metrics)) {
    const p = previous.metrics[key], d = insights.differences[key];
    lines.push(`| ${text(m.label)} (${m.unit}) | ${value(m.value)} | ${value(p.value)} | ${d.reason ? reason(d.reason) : `${d.value > 0 ? '+' : ''}${value(d.value)}${m.unit === '%' ? ' percentage points' : ''}`} | ${m.count} / ${p.count}; need ${m.required} each |`);
  }
  lines.push('', insights.rules.consistency, 'Changes describe each measurement independently; higher or lower physiology is not automatically better or worse.',
    '', '## Baseline evidence for the selected night', '', 'Baseline: 14 usable prior observations within 28 calendar days, with matching source and method.');
  for (const [key, b] of Object.entries(insights.baselineEvidence)) {
    if (!Object.hasOwn(current.metrics, key)) continue;
    lines.push(`- ${current.metrics[key].label}: ${b.count}/14 prior observations; median ${value(b.median)}, p10–p90 ${value(b.p10)}–${value(b.p90)}; selected value ${value(b.value)}${b.eligible ? '' : ' (excluded from comparisons)'}. Dates: ${b.dates.join(', ') || 'none'}.`);
  }
  lines.push('', '## Freshness and missing data', '',
    `Connection: ${text(insights.freshness.connectionState)}. Last successful fetch (any stream): ${text(insights.freshness.lastSuccessfulFetch)}. Newest stored measurement: ${text(insights.freshness.newestMeasurementAt)}.`);
  for (const [metric, status] of Object.entries(insights.availability)) {
    lines.push(`- ${metric}: ${status.observationState}; ${status.recordCount} stored observations in the fetch window; complete fetch coverage: ${status.fetchComplete ? 'yes' : 'no'}; last successful fetch: ${text(status.lastSuccessfulFetchAt)}${status.errorCode ? `; ${status.errorCode}${status.httpStatus ? ` (HTTP ${status.httpStatus})` : ''}` : ''}.`);
  }
  lines.push(insights.rules.missing);
  if (insights.checkInComparisons) {
    lines.push('', '## Optional check-in associations', '', insights.rules.habits,
      `Neutral restfulness (3): ${insights.checkInComparisons.restfulness.neutralDates.join(', ') || 'none'}.`);
    for (const group of [insights.checkInComparisons.restfulness, ...insights.checkInComparisons.factors]) {
      lines.push('', `**${group.firstLabel} versus ${group.secondLabel}**`);
      for (const m of Object.values(group.metrics)) lines.push(`- ${m.label}: ${value(m.first.value)} versus ${value(m.second.value)} ${m.unit}; ${m.first.count}/${m.second.count} nights; ${m.difference.reason ? reason(m.difference.reason) : `difference ${value(m.difference.value)} ${m.unit}`}.`);
    }
  }
  lines.push('', '## Nightly records', '',
    `| Wake date | State | Asleep min | WASO min | Efficiency % | Bed / wake (local) | HR bpm | HRV ms | Breathing /min | Skin °C | SpO₂ % | Naps min |${insights.checkInComparisons ? ' Restfulness / context |' : ''}`,
    `| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |${insights.checkInComparisons ? ' --- |' : ''}`);
  const clock = n => Number.isFinite(n) ? `${String(Math.floor(((Math.round(n) % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(Math.round(n) % 60).padStart(2, '0')}` : '—';
  for (const night of insights.nights) {
    const measured = key => `${value(night.metrics[key]?.value)}${Number.isFinite(night.metrics[key]?.value) && !night.metrics[key].eligible ? '*' : ''}`;
    const checkIn = night.checkIn;
    lines.push(`| ${night.date} | ${night.state} | ${measured('duration')} | ${measured('afterOnset')} | ${measured('efficiency')} | ${clock(night.metrics.bedtime?.value)} / ${clock(night.metrics.wakeTime?.value)} | ${measured('sleepingHr')} | ${measured('hrv')} | ${measured('breathing')} | ${measured('temperature')} | ${measured('spo2')} | ${value(night.naps.minutesAsleep)} |${insights.checkInComparisons ? ` ${checkIn ? `${value(checkIn.restfulness)}; ${text(checkIn.context.join(', ') || (checkIn.contextReviewed ? 'None of these factors' : 'context unanswered'))}` : 'Unanswered'} |` : ''}`);
  }
  lines.push('', '*Recorded value excluded from comparisons because processing, source, or observation coverage is insufficient.',
    '', '## Suggested analysis prompt', '',
    'Analyze this sleep report. Reference specific dates and values. Acknowledge missing measurements and sample-size limits. Distinguish descriptive associations from causes. Discuss each sleep dimension separately and do not invent an overall score or assume higher/lower physiology is healthier.',
    '', `Calculation version: ${insights.schemaVersion}. No external AI calls were made.`, '');
  return { schemaVersion: 'sleep-summary-v1', summary: insights, markdown: lines.join('\n') };
}
