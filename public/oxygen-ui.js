const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const percent = value => value == null ? '—' : `${Number(value).toFixed(1)}%`;
const fullPercent = value => value == null ? '—' : `${value}%`;
const count = value => Number(value ?? 0).toLocaleString();
const fact = (label, value) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`;
const panel = (title, content) => `<section class="workspace-panel oxygen-panel"><h2>${title}</h2>${content}</section>`;

export function oxygenAxis(values) {
  const minimum = Math.min(85, ...values.filter(value => typeof value === 'number' && Number.isFinite(value)));
  return { minimum: Math.floor(minimum / 5) * 5, maximum: 100 };
}

export function oxygenStatusMessage(data) {
  if (Object.values(data.sync ?? {}).some(status => status.lastAttemptStatus === 'failed')) return 'SpO₂ sync failed. Saved readings remain available. Check the connection in Settings or retry Sync.';
  if (Object.values(data.sync ?? {}).some(status => status.lastAttemptStatus === 'running')) return 'SpO₂ sync is running. Any saved readings remain available while it finishes.';
  if (Object.values(data.sync ?? {}).some(status => status.lastAttemptStatus === 'queued')) return 'SpO₂ sync is queued. Any saved readings remain available while it waits.';
  if (data.qualityFlags?.includes('daily-ambiguous')) return 'Multiple provider daily records are available for this source. Review the records below; a combined daily average is unavailable.';
  if (data.sampleSummary?.sampleCount === 0 && data.sampleSummary?.conflictCount > 0) return 'The stored observations conflict at their timestamps. Review the reading table; these values are excluded from statistics.';
  if (data.dataState === 'source-selection-required') return 'Choose a source for each available dataset. Metadata groups are not verified device identities.';
  if (data.dataState === 'empty') return 'No SpO₂ readings returned for this period.';
  if (data.dataState === 'summary-only') return 'Daily summary available; individual readings are not stored locally.';
  if (data.dataState === 'not-synced') return 'SpO₂ has not been fetched completely for this period.';
  if (Object.values(data.sync ?? {}).some(status => status.fetchComplete === false)) return 'This period has not been fetched completely. The readings below are stored locally.';
  return '';
}

function sourceSelect(sources = [], selected, type) {
  if (!sources.length) return '';
  return `<label class="oxygen-source"><span>${type === 'sample' ? 'Sample' : 'Daily summary'} source</span><select data-oxygen-source="${type}">
    ${!selected ? '<option value="">Choose a source</option>' : ''}
    ${sources.map(source => `<option value="${escape(source.key)}" ${source.key === selected ? 'selected' : ''}>${escape(source.label)} · ${source.key.slice(0, 6)} (${count(source.recordCount)} records)</option>`).join('')}
    </select></label>`;
}

function timeLabel(timestamp, offset = 0) {
  if (!timestamp) return '—';
  return new Date(Date.parse(timestamp) + offset * 1000).toISOString().slice(11, 16);
}

function recordedTimeLabel(timestamp, offset = 0) {
  if (!timestamp) return '—';
  const sign = offset < 0 ? '−' : '+';
  const zone = `${sign}${String(Math.floor(Math.abs(offset) / 3600)).padStart(2, '0')}:${String(Math.floor(Math.abs(offset) % 3600 / 60)).padStart(2, '0')}`;
  const local = new Date(Date.parse(timestamp) + offset * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `${local} UTC${zone}`;
}

function sampleLabel(sample) {
  return `${recordedTimeLabel(sample.sampledAt, sample.utcOffsetSeconds ?? 0)} · ${fullPercent(sample.percentage)}`;
}

function fetchHistory(sync = {}) {
  return `<details><summary>Fetch history</summary>${Object.entries(sync).map(([metric, status]) => `<p><strong>${metric === 'intraday' ? 'Individual readings' : 'Daily summaries'}</strong></p><dl class="oxygen-facts">${fact('Latest attempt', `${status.lastAttemptStatus ?? 'not-synced'} · ${status.lastAttemptAt ?? '—'}`)}${fact('Last completed fetch', status.lastSuccessfulFetchAt ?? '—')}${fact('Requested dates fetched completely', status.fetchComplete ? 'Yes' : 'No')}</dl>`).join('')}<p class="oxygen-muted">Fetch timestamps are UTC. A completed fetch does not prove continuous sensor coverage.</p></details>`;
}

function chart({ segments = [], values = [], start, end, startLabel, endLabel, stages = [], trend = false }) {
  const { minimum, maximum } = oxygenAxis(values);
  const x = time => 64 + 792 * (time - start) / Math.max(1, end - start);
  const y = value => 240 - (value - minimum) * 210 / (maximum - minimum);
  const ticks = [];
  const step = Math.max(5, Math.ceil((maximum - minimum) / 4 / 5) * 5);
  for (let value = minimum; value <= maximum; value += step) ticks.push(value);
  if (ticks.at(-1) !== maximum) ticks.push(maximum);
  const pointMarkup = point => {
    const label = trend ? `${point.date} · ${percent(point.percentage)}` : sampleLabel(point);
    return `<circle cx="${x(point.time)}" cy="${y(point.percentage)}" r="3" tabindex="0" ${trend ? `role="button" data-oxygen-date="${point.date}"` : ''} data-oxygen-point="${escape(label)}" aria-label="${escape(label)}"><title>${escape(label)}</title></circle>`;
  };
  const colors = { awake: 'var(--awake)', rem: 'var(--rem)', light: 'var(--light)', deep: 'var(--deep)' };
  return `<svg class="oxygen-chart" viewBox="0 0 900 325" role="img" aria-label="${trend ? 'Daily blood oxygen averages and confidence bounds' : 'Blood oxygen readings and sleep stages'}; axis ${minimum} to 100 percent">
    ${ticks.map(value => `<line x1="64" x2="856" y1="${y(value)}" y2="${y(value)}" class="oxygen-grid"/><text x="52" y="${y(value) + 4}" text-anchor="end">${value}%</text>`).join('')}
    ${segments.map(segment => {
      const bands = []; let band = [];
      for (const point of segment) {
        if (point.lowerBoundPercentage == null || point.upperBoundPercentage == null) { if (band.length) bands.push(band); band = []; }
        else band.push(point);
      }
      if (band.length) bands.push(band);
      return `${bands.map(run => `<polygon class="oxygen-band" points="${run.map(p => `${x(p.time)},${y(p.lowerBoundPercentage)}`).concat([...run].reverse().map(p => `${x(p.time)},${y(p.upperBoundPercentage)}`)).join(' ')}"/>`).join('')}
        <polyline class="oxygen-line" points="${segment.map(p => `${x(p.time)},${y(p.percentage)}`).join(' ')}"/>${segment.map(pointMarkup).join('')}`;
    }).join('')}
    <text x="64" y="265">${escape(startLabel)}</text><text x="856" y="265" text-anchor="end">${escape(endLabel)}</text>
    ${stages.map(stage => {
      const left = x(Math.max(start, Date.parse(stage.startTime))), right = x(Math.min(end, Date.parse(stage.endTime)));
      return right > left ? `<rect x="${left}" y="282" width="${right - left}" height="16" fill="${colors[stage.type] ?? '#929aa7'}"><title>${escape(stage.type)}</title></rect>` : '';
    }).join('')}
  </svg>`;
}

function candidatesTable(rows = []) {
  if (rows.length < 2) return '';
  return `<details><summary>Provider daily records (${rows.length})</summary><p>Multiple records in one selected source remain ambiguous.</p><div class="oxygen-table-scroll"><table><thead><tr><th>Record</th><th>Average</th><th>Confidence bounds</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.providerId)}</td><td>${percent(row.averagePercentage)}</td><td>${percent(row.lowerBoundPercentage)} – ${percent(row.upperBoundPercentage)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

export function renderOxygenCard(day) {
  if (!day) return '<p>SpO₂ has not been fetched for this date.</p>';
  const daily = day.dailySummary;
  const value = daily?.averagePercentage ?? day.sampleSummary?.averagePercentage;
  return `<div class="panel-heading"><div><span class="metric-name">Blood oxygen · SpO₂</span><h2 id="oxygenSummaryHeading">${percent(value)}</h2></div><span class="open-indicator">Detail →</span></div>
    <p>${daily ? 'Google daily average' : 'Sample average'} · ${escape(day.date)}</p>
    <p class="oxygen-muted">${daily ? `Confidence bounds ${percent(daily.lowerBoundPercentage)} – ${percent(daily.upperBoundPercentage)}` : escape(oxygenStatusMessage(day))}</p>`;
}

export function renderOxygenNight(day, { readingPage = 0 } = {}) {
  const summary = day.sampleSummary ?? {}, daily = day.dailySummary;
  const samples = day.samples ?? [];
  const pageCount = Math.max(1, Math.ceil(samples.length / 200));
  const page = Math.max(0, Math.min(readingPage, pageCount - 1));
  const window = day.window ?? {};
  const plotSegments = (day.plot?.segments ?? []).map(segment => segment.map(point => ({ ...point, time: Date.parse(point.sampledAt) })));
  const start = Date.parse(window.startTime ?? samples[0]?.sampledAt), end = Date.parse(window.endTime ?? samples.at(-1)?.sampledAt);
  const status = oxygenStatusMessage(day);
  const chartMarkup = samples.length ? chart({ segments: plotSegments, values: samples.map(row => row.percentage), start, end,
    startLabel: timeLabel(window.startTime ?? samples[0].sampledAt, day.sleepSession?.startOffsetSeconds ?? samples[0].utcOffsetSeconds),
    endLabel: timeLabel(window.endTime ?? samples.at(-1).sampledAt, day.sleepSession?.endOffsetSeconds ?? samples.at(-1).utcOffsetSeconds), stages: day.sleepSession?.stages ?? [] })
    : '<p class="workspace-empty">No selected individual readings to plot.</p>';
  return `<div class="oxygen-source-row">${sourceSelect(day.sampleSources, day.selectedSampleSource, 'sample')}${sourceSelect(day.dailySources, day.selectedDailySource, 'daily')}</div>
    ${status ? `<p class="oxygen-notice" role="status">${escape(status)}</p>` : ''}
    <div class="oxygen-summary-grid">${panel('Google daily summary', `<dl class="oxygen-facts">${fact('Average', percent(daily?.averagePercentage))}${fact('Confidence bounds', `${percent(daily?.lowerBoundPercentage)} – ${percent(daily?.upperBoundPercentage)}`)}</dl><p class="oxygen-muted">Provider date ${escape(day.date)}. Confidence bounds are not the lowest and highest readings.</p>${daily?.standardDeviationPercentage != null ? `<details><summary>Historical standard deviation</summary><p>${percent(daily.standardDeviationPercentage)} across prior daily averages (7–30 days), not variability during this night.</p></details>` : ''}${candidatesTable(day.dailyCandidates)}`)}
    ${panel('Selected sample statistics', `<dl class="oxygen-facts">${fact('Mean', percent(summary.averagePercentage))}${fact('Minimum / median / maximum', `${percent(summary.minimumPercentage)} / ${percent(summary.medianPercentage)} / ${percent(summary.maximumPercentage)}`)}${fact('Usable observations', count(summary.sampleCount))}</dl>`)}</div>
    ${panel(window.kind === 'sleep-session' ? 'Selected sleep session' : 'Calendar-day samples — sleep session unavailable', `${chartMarkup}
      <output id="oxygenReading" class="oxygen-reading" aria-live="polite">Focus or tap a point for its reading.</output>
      ${day.sleepSession ? `<dl class="oxygen-facts">${fact('Sleep starts', recordedTimeLabel(window.startTime, day.sleepSession.startOffsetSeconds ?? 0))}${fact('Sleep ends', recordedTimeLabel(window.endTime, day.sleepSession.endOffsetSeconds ?? 0))}</dl>` : ''}
      ${day.sleepSession ? '<p class="oxygen-muted">Sleep stages: awake · REM · light · deep. Same time axis; no physiological relationship is inferred.</p>' : ''}
      <p class="oxygen-muted">${day.plot?.reduced ? 'Chart reduced using first/minimum/maximum/last readings. ' : ''}Lines break after gaps over 120 seconds or conflicting readings. Time labels use recorded offsets.</p>`)}
    ${panel('Sampling details', `<dl class="oxygen-facts">${fact('Minutes containing a reading', summary.sleepWindowMinuteCount == null ? `${count(summary.observedMinuteCount)} · sleep denominator unavailable` : `${count(summary.observedMinuteCount)} of ${count(summary.sleepWindowMinuteCount)} (${((summary.observedMinuteFraction ?? 0) * 100).toFixed(1)}%)`)}${fact('Interior gaps / longest gap', `${count(summary.gapCount)} / ${count(summary.longestGapSeconds)} seconds`)}${fact('Duplicates / conflicting timestamps', `${count(summary.duplicateCount)} / ${count(summary.conflictCount)}`)}</dl>
      <p class="oxygen-muted">These counts describe stored observations, not continuous sensor coverage.</p><dl class="oxygen-facts">${fact('Newest stored reading', day.newestSampleAt ?? '—')}</dl>${fetchHistory(day.sync)}${day.qualityFlags?.length ? `<p>Data notes: ${day.qualityFlags.map(escape).join(', ')}.</p>` : ''}`)}
    ${panel('Reading table', `<p>${count(samples.length)} provider readings, including duplicates and conflicts. Original timestamps are retained.</p><div class="oxygen-table-scroll" tabindex="0" role="region" aria-label="Blood oxygen reading table"><table><thead><tr><th>Original timestamp</th><th>SpO₂</th><th>UTC offset (s)</th><th>Notes</th></tr></thead><tbody>${samples.slice(page * 200, (page + 1) * 200).map(row => `<tr><td>${escape(row.sampledAt)}</td><td>${fullPercent(row.percentage)}</td><td>${row.utcOffsetSeconds}</td><td>${row.conflict ? 'Conflict · excluded from statistics' : row.duplicate ? 'Duplicate observation' : '—'}</td></tr>`).join('')}</tbody></table></div>
      ${pageCount > 1 ? `<div class="oxygen-table-paging"><button type="button" class="button button-secondary" data-oxygen-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>Previous readings</button><span>Page ${page + 1} of ${pageCount}</span><button type="button" class="button button-secondary" data-oxygen-page="${page + 1}" ${page + 1 === pageCount ? 'disabled' : ''}>Next readings</button></div>` : ''}`)}`;
}

export function renderOxygenTrend(range) {
  const days = range.days ?? [], values = [], segments = [];
  let segment = null;
  for (const day of days) {
    if (!day.dailySummary) { segment = null; continue; }
    if (!segment) { segment = []; segments.push(segment); }
    const point = { ...day.dailySummary, date: day.date, time: Date.parse(day.date), percentage: day.dailySummary.averagePercentage };
    segment.push(point); values.push(point.percentage, point.lowerBoundPercentage, point.upperBoundPercentage);
  }
  const summary = range.periodSummary ?? {};
  const message = oxygenStatusMessage({ ...range, qualityFlags: days.some(day => day.qualityFlags?.includes('daily-ambiguous')) ? ['daily-ambiguous'] : [], dataState: !values.length ? days.some(day => day.dataState === 'source-selection-required') ? 'source-selection-required' : days.every(day => day.dataState === 'empty') ? 'empty' : 'not-synced' : 'ready' });
  return `<div class="oxygen-source-row">${sourceSelect(range.dailySources, range.selectedDailySource, 'daily')}</div>${message ? `<p class="oxygen-notice" role="status">${escape(message)}</p>` : ''}
    ${panel('Daily blood oxygen', `<dl class="oxygen-facts">${fact('Average of daily averages', percent(summary.averageDailyPercentage))}${fact('Daily summaries', `${count(summary.daysWithSummary)} of ${count(summary.requestedDays)} days`)}</dl>
      ${days.length ? chart({ segments, values, start: Date.parse(days[0].date), end: Date.parse(days.at(-1).date), startLabel: days[0].date, endLabel: days.at(-1).date, trend: true }) : ''}
      <output id="oxygenReading" class="oxygen-reading" aria-live="polite">Select a point or date to open that night.</output><p class="oxygen-muted">Each available daily average has equal weight. Shading shows provider confidence bounds. Missing dates break the line.</p>
      <div class="oxygen-table-scroll" tabindex="0" role="region" aria-label="Daily blood oxygen table"><table><thead><tr><th>Date</th><th>Average</th><th>Confidence bounds</th><th>State</th></tr></thead><tbody>${days.map(day => `<tr><td><button class="oxygen-date-link" type="button" data-oxygen-date="${day.date}">${day.date}</button></td><td>${percent(day.dailySummary?.averagePercentage)}</td><td>${percent(day.dailySummary?.lowerBoundPercentage)} – ${percent(day.dailySummary?.upperBoundPercentage)}</td><td>${escape(day.qualityFlags?.includes('daily-ambiguous') ? 'Ambiguous provider records' : day.dataState)}</td></tr>`).join('')}</tbody></table></div>${fetchHistory(range.sync)}`)}`;
}
