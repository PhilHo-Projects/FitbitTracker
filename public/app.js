import {
  buildSleepTrendRows,
  buildSleepLanes,
  civilDateInTimeZone,
  dateRangeForPreset,
  exportPollingNeeded,
  formatDuration,
  isLocalDevelopmentHost,
  scaleSleepTrendRows,
  sleepStageBreakdown,
  sleepTrendRange,
} from './health-ui.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localDevelopment = isLocalDevelopmentHost(window.location.hostname);
$('#environmentBanner').hidden = !localDevelopment;
document.body.classList.toggle('is-local-development', localDevelopment);
const profileTimezone = 'America/Toronto';
let today = civilDateInTimeZone(new Date(), profileTimezone);
const stageNames = { awake: 'Awake', light: 'Light', deep: 'Deep', rem: 'REM' };
const state = {
  selectedDate: today,
  activeView: 'today',
  ranges: { heart: 'day', calories: 'day' },
  sleepTrendPeriod: '7-days',
  dashboard: null,
  journal: [],
  exportPoll: null,
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatDate(date, options = {}) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    weekday: options.short ? 'short' : 'long',
    month: options.compact ? 'short' : 'long',
    day: 'numeric',
    year: options.year ? 'numeric' : undefined,
  });
}

function formatTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function numeric(value, suffix = '') {
  return value === null || value === undefined ? '—' : `${Math.round(Number(value))}${suffix}`;
}

function coverageHours(seconds) {
  if (!seconds) return 'No coverage';
  return `${Math.min(24, Math.round((seconds / 3600) * 10) / 10)}h`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Authentication required');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `Request failed with HTTP ${response.status}`);
  }
  return payload.data ?? payload;
}

function showNotice(message = '', kind = 'error') {
  const notice = $('#notice');
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.hidden = true;
  }, 2800);
}

function setSyncState(status, label) {
  const element = $('#syncStatus');
  element.dataset.state = status;
  $('span', element).textContent = label;
}

function selectedDayLabel() {
  if (state.selectedDate === today) return 'Today';
  if (state.selectedDate === shiftDate(today, -1)) return 'Yesterday';
  return formatDate(state.selectedDate, { compact: true, year: true });
}

function updateDateControls() {
  today = civilDateInTimeZone(new Date(), profileTimezone);
  $('#datePicker').value = state.selectedDate;
  $('#datePicker').max = today;
  $('#nextDate').disabled = state.selectedDate >= today;
  $('#todayButton').disabled = state.selectedDate === today;
  $('#todayHeading').textContent = selectedDayLabel();
  $('#todaySubheading').textContent = `${formatDate(state.selectedDate, { year: true })} · what happened across sleep, heart, calories, and context.`;
  $('#exportStart').value ||= shiftDate(state.selectedDate, -29);
  $('#exportEnd').value ||= shiftDate(state.selectedDate, 1);
}

function renderStageSummary(sleep) {
  const stages = sleepStageBreakdown(sleep.stageSummary, sleep.durationMinutes);
  $('#todaySleepBar').innerHTML = stages
    .filter(({ percentage }) => percentage > 0)
    .map(
      ({ type, percentage }) =>
        `<span data-stage="${type}" style="width:${percentage}%" title="${stageNames[type]} ${percentage}%"></span>`,
    )
    .join('');
  $('#todaySleepBar').setAttribute(
    'aria-label',
    stages.map(({ type, duration, percentage }) => `${stageNames[type]} ${duration}, ${percentage}%`).join('; '),
  );
  $('#todayStageRow').innerHTML = stages
    .map(
      ({ type, duration, percentage }) => `
        <div class="stage-cell">
          <span><i data-stage="${type}"></i>${stageNames[type]}</span>
          <strong>${duration}</strong>
          <small>${percentage}%</small>
        </div>`,
    )
    .join('');
}

function renderToday(data, journal) {
  state.dashboard = data;
  state.journal = journal;
  const sleep = data.sleep;
  $('#todaySleepEmpty').hidden = Boolean(sleep);
  $('#todaySleepData').hidden = !sleep;
  if (sleep) {
    $('#sleepDuration').textContent = formatDuration(sleep.durationMinutes);
    $('#sleepWindow').textContent = `${formatTime(sleep.startTime)}–${formatTime(sleep.endTime)}`;
    $('#sleepAsleep').textContent = formatDuration(sleep.minutesAsleep);
    $('#sleepEfficiency').textContent = sleep.efficiency === null ? '—' : `${sleep.efficiency}%`;
    renderStageSummary(sleep);
  } else {
    $('#sleepDuration').textContent = 'No record';
    $('#sleepWindow').textContent = 'No sleep session stored for this date.';
  }

  const heart = data.heart;
  $('#heartSummaryData').hidden = heart.missing;
  $('#heartMissing').hidden = !heart.missing;
  $('#heartResting').textContent = numeric(heart.restingBpm);
  $('#heartRange').textContent =
    heart.minimumBpm === null ? '—' : `${Math.round(heart.minimumBpm)}–${Math.round(heart.maximumBpm)} bpm`;
  $('#heartAverage').textContent = numeric(heart.averageBpm, ' bpm');
  $('#heartSamples').textContent = heart.sampleCount ? heart.sampleCount.toLocaleString() : '—';

  const calories = data.calories;
  $('#calorieSummaryData').hidden = calories.missing;
  $('#calorieMissing').hidden = !calories.missing;
  $('#calorieTotal').textContent = numeric(calories.totalKcal);
  $('#calorieActive').textContent = numeric(calories.activeKcal, ' kcal');
  $('#calorieBasal').textContent = numeric(calories.basalKcal, ' kcal');
  $('#calorieCoverage').textContent = coverageHours(calories.coverageSeconds);

  const latest = journal[0];
  $('#latestContext').innerHTML = latest
    ? `<p>${escapeHtml(latest.body)}</p><div class="tag-row">${latest.tags
        .map((tag) => `<span>${escapeHtml(tag)}</span>`)
        .join('')}</div>`
    : '<p>No journal entry yet. Add exercise, substances, illness, stress, travel, meals, or anything else that gives the numbers meaning.</p>';

  $('#todayLoading').hidden = true;
  $('#todayContent').hidden = false;
  const sync = data.sync;
  setSyncState(sync?.stale ? 'stale' : 'ok', sync?.lastSuccessfulSync ? `Synced ${new Date(sync.lastSuccessfulSync).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Local archive');
}

async function loadToday() {
  showNotice();
  $('#todayLoading').hidden = false;
  $('#todayContent').hidden = true;
  const end = shiftDate(state.selectedDate, 1);
  try {
    const [dashboard, journal] = await Promise.all([
      fetchJson(`/api/dashboard?date=${state.selectedDate}`),
      fetchJson(`/api/journal?start=${state.selectedDate}&end=${end}`).catch(() => []),
    ]);
    renderToday(dashboard, journal);
  } catch (error) {
    $('#todayLoading').hidden = true;
    showNotice(error.message);
  }
}

function laneMarkup(session) {
  if (!session.stages?.length) {
    return '<div class="workspace-empty">This is a classic sleep record. Stage chronology was not available.</div>';
  }
  const lanes = buildSleepLanes(session.stages, session.startTime, session.endTime);
  return `
    <div class="sleep-lanes" aria-label="Chronological sleep stage timeline">
      ${['awake', 'rem', 'light', 'deep']
        .map(
          (type) => `
            <div class="sleep-lane">
              <span class="lane-label"><i data-stage="${type}"></i>${stageNames[type]}</span>
              <div class="lane-track">
                ${lanes[type]
                  .map(
                    (segment) =>
                      `<span data-stage="${type}" style="left:${segment.leftPercent}%;width:${Math.max(0.35, segment.widthPercent)}%" title="${stageNames[type]} · ${formatDuration(segment.durationMinutes)}"></span>`,
                  )
                  .join('')}
              </div>
            </div>`,
        )
        .join('')}
      <div class="lane-axis"><span>${formatTime(session.startTime)}</span><span>${formatTime(session.endTime)}</span></div>
    </div>`;
}

function trendBars(rows, valueKey, formatter, stack = false) {
  if (!rows.length) return '<div class="workspace-empty">No records in this range.</div>';
  const maximum = Math.max(
    1,
    ...rows.map((row) =>
      stack ? Number(row.activeKcal || 0) + Number(row.basalKcal || 0) : Number(row[valueKey] || 0),
    ),
  );
  return `<div class="trend-bars">${rows
    .map((row) => {
      if (stack) {
        const active = (Number(row.activeKcal || 0) / maximum) * 100;
        const basal = (Number(row.basalKcal || 0) / maximum) * 100;
        return `<div class="trend-column" title="${escapeHtml(formatDate(row.date))}: ${escapeHtml(formatter(row.totalKcal))}">
          <span class="trend-value">${escapeHtml(formatter(row.totalKcal))}</span>
          <div class="trend-track"><i class="bar-active" style="height:${active}%"></i><i class="bar-basal" style="height:${basal}%"></i></div>
          <span>${escapeHtml(formatDate(row.date, { short: true }).split(',')[0])}</span>
        </div>`;
      }
      const height = (Number(row[valueKey] || 0) / maximum) * 100;
      return `<div class="trend-column" title="${escapeHtml(formatDate(row.date))}: ${escapeHtml(formatter(row[valueKey]))}">
        <span class="trend-value">${escapeHtml(formatter(row[valueKey]))}</span>
        <div class="trend-track"><i style="height:${Math.max(2, height)}%"></i></div>
        <span>${escapeHtml(formatDate(row.date, { short: true }).split(',')[0])}</span>
      </div>`;
    })
    .join('')}</div>`;
}

function sleepTrendMarkup(sessions) {
  const period = state.sleepTrendPeriod;
  const scaled = scaleSleepTrendRows(
    buildSleepTrendRows(sessions, period, state.selectedDate),
  );
  const descriptions = {
    '7-days': 'Seven daily sleep periods',
    '1-month': 'Four rolling seven-day averages',
    '1-year': 'Twelve calendar-month averages',
  };
  const controls = [
    ['7-days', '7 days'],
    ['1-month', '1 month'],
    ['1-year', '1 year'],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-sleep-trend-period="${value}" class="${period === value ? 'is-active' : ''}" aria-pressed="${period === value}">${label}</button>`,
    )
    .join('');

  return `
    <section class="workspace-panel sleep-trend-panel">
      <div class="section-title sleep-trend-heading">
        <div>
          <h2>Sleep duration trend</h2>
          <p id="sleepTrendDescription">${descriptions[period]}. The 7h line is your personal target.</p>
        </div>
        <div class="range-tabs sleep-trend-tabs" aria-label="Sleep duration trend period">${controls}</div>
      </div>
      <div class="sleep-trend" role="list" aria-describedby="sleepTrendDescription">
        <div class="sleep-trend-scale" aria-hidden="true">
          <span style="left:${scaled.targetPercent}%">7h target</span>
        </div>
        ${scaled.rows
          .map((row) => {
            const missing = row.targetState === 'missing';
            const status = missing
              ? 'Missing'
              : row.targetState === 'reached'
                ? 'Target reached'
                : 'Below 7h target';
            const duration = missing ? 'Missing' : formatDuration(row.durationMinutes);
            return `
              <div class="sleep-trend-row is-${row.targetState}" role="listitem" aria-label="${escapeHtml(`${row.label}: ${duration}. ${status}.`)}">
                <span class="sleep-trend-label">${escapeHtml(row.label)}</span>
                <div class="sleep-trend-rail">
                  <i style="width:${row.fillPercent}%"></i>
                  <b class="sleep-target-marker" style="left:${scaled.targetPercent}%" aria-hidden="true"></b>
                </div>
                <div class="sleep-trend-value"><strong>${duration}</strong><small>${status}</small></div>
              </div>`;
          })
          .join('')}
      </div>
    </section>`;
}

async function loadSleepWorkspace() {
  const root = $('#sleepWorkspace');
  root.innerHTML = '<div class="workspace-loading skeleton"></div>';
  const range = sleepTrendRange(state.sleepTrendPeriod, state.selectedDate);
  try {
    const data = await fetchJson(`/api/metrics/sleep?start=${range.startDate}&end=${range.endDateExclusive}`);
    const selected = data.sessions.find(({ date }) => date === state.selectedDate);
    const selectedNight = selected
      ? (() => {
          const stages = sleepStageBreakdown(selected.stageSummary, selected.durationMinutes);
          return `
            <section class="workspace-summary sleep-workspace-summary">
              <div class="sleep-period-cell">
                <div class="sleep-period-heading"><span>Sleep period</span><small>${formatTime(selected.startTime)}–${formatTime(selected.endTime)}</small></div>
                <strong>${formatDuration(selected.durationMinutes)}</strong>
              </div>
              <dl>
                <div><dt>Asleep</dt><dd>${formatDuration(selected.minutesAsleep)}</dd></div>
                <div><dt>Awake</dt><dd>${formatDuration(selected.minutesAwake)}</dd></div>
                <div><dt>Efficiency</dt><dd>${selected.efficiency ?? '—'}%</dd></div>
                <div><dt>Fell asleep</dt><dd>${formatDuration(selected.timeToSleepMinutes)}</dd></div>
                <div><dt>Awake episodes</dt><dd>${selected.awakeEpisodes ?? '—'}</dd></div>
              </dl>
            </section>
            <section class="workspace-panel">
              <div class="section-title"><div><h2>${formatDate(selected.date, { year: true })}</h2><p>Four-lane chronological timeline</p></div><span>${selected.type === 'stages' ? 'Detailed stages' : 'Classic sleep'}</span></div>
              ${laneMarkup(selected)}
              <div class="stage-row workspace-stage-row">${stages
                .map(({ type, duration, percentage }) => `<div class="stage-cell"><span><i data-stage="${type}"></i>${stageNames[type]}</span><strong>${duration}</strong><small>${percentage}%</small></div>`)
                .join('')}</div>
            </section>`;
        })()
      : '<div class="workspace-empty">No sleep session stored for the selected date.</div>';
    root.innerHTML = `${selectedNight}${sleepTrendMarkup(data.sessions)}`;
  } catch (error) {
    root.innerHTML = `<div class="workspace-empty error-copy">${escapeHtml(error.message)}</div>`;
  }
}

function rangePlot(points, dayMode) {
  if (!points.length) return '<div class="workspace-empty">No heart readings in this range.</div>';
  const values = points.flatMap((point) => [point.minimumBpm, point.maximumBpm]).filter(Number.isFinite);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const span = Math.max(1, maximum - minimum);
  const label = dayMode ? 'time' : 'date';
  return `<div class="range-plot" role="img" aria-label="Heart rate minimum, average, and maximum by ${label}">
    ${points
      .map((point) => {
        const low = ((point.minimumBpm - minimum) / span) * 100;
        const high = ((point.maximumBpm - minimum) / span) * 100;
        const average = ((point.averageBpm - minimum) / span) * 100;
        const title = dayMode ? new Date(point.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : formatDate(point.date, { short: true });
        return `<div class="range-mark" title="${escapeHtml(title)} · ${Math.round(point.minimumBpm)}–${Math.round(point.maximumBpm)} bpm">
          <i style="bottom:${low}%;height:${Math.max(2, high - low)}%"></i>
          <b style="bottom:${average}%"></b>
          <span>${escapeHtml(title)}</span>
        </div>`;
      })
      .join('')}
    <div class="plot-scale"><span>${Math.round(maximum)}</span><span>${Math.round(minimum)}</span></div>
  </div>`;
}

async function loadHeartWorkspace() {
  const root = $('#heartWorkspace');
  root.innerHTML = '<div class="workspace-loading skeleton"></div>';
  const preset = state.ranges.heart;
  const range = dateRangeForPreset(preset, state.selectedDate);
  const resolution = preset === 'day' ? 'five-minute' : 'day';
  try {
    const data = await fetchJson(`/api/metrics/heart?start=${range.startDate}&end=${range.endDateExclusive}&resolution=${resolution}`);
    const summary = preset === 'day' ? data.summary : data.days.at(-1);
    const points = preset === 'day' ? data.points : data.days;
    root.innerHTML = `
      <section class="workspace-summary">
        <div><span>Resting heart rate</span><strong>${numeric(summary?.restingBpm, ' bpm')}</strong></div>
        <dl>
          <div><dt>Average</dt><dd>${numeric(summary?.averageBpm, ' bpm')}</dd></div>
          <div><dt>Minimum</dt><dd>${numeric(summary?.minimumBpm, ' bpm')}</dd></div>
          <div><dt>Maximum</dt><dd>${numeric(summary?.maximumBpm, ' bpm')}</dd></div>
          <div><dt>Readings</dt><dd>${summary?.sampleCount?.toLocaleString?.() ?? '—'}</dd></div>
          <div><dt>Coverage</dt><dd>${coverageHours(summary?.coverageSeconds)}</dd></div>
        </dl>
      </section>
      <section class="workspace-panel">
        <div class="section-title"><div><h2>${preset === 'day' ? 'Five-minute readings' : 'Daily resting and range'}</h2><p>Vertical marks show min–max; dots show averages. Missing time remains blank.</p></div></div>
        ${rangePlot(points, preset === 'day')}
      </section>`;
  } catch (error) {
    root.innerHTML = `<div class="workspace-empty error-copy">${escapeHtml(error.message)}</div>`;
  }
}

function hourlyCalories(intervals) {
  if (!intervals.length) return '<div class="workspace-empty">No calorie intervals for this day.</div>';
  const maximum = Math.max(1, ...intervals.map(({ totalKcal }) => totalKcal));
  return `<div class="hourly-bars">${intervals
    .map((point) => {
      const active = (point.activeKcal / maximum) * 100;
      const basal = (point.basalKcal / maximum) * 100;
      return `<div class="hour-column" title="${new Date(point.time).toLocaleTimeString([], { hour: 'numeric' })} · ${Math.round(point.totalKcal)} kcal">
        <div class="hour-track"><i class="bar-active" style="height:${active}%"></i><i class="bar-basal" style="height:${basal}%"></i></div>
        <span>${new Date(point.time).getHours() % 3 === 0 ? new Date(point.time).toLocaleTimeString([], { hour: 'numeric' }) : ''}</span>
      </div>`;
    })
    .join('')}</div>`;
}

async function loadCalorieWorkspace() {
  const root = $('#calorieWorkspace');
  root.innerHTML = '<div class="workspace-loading skeleton"></div>';
  const preset = state.ranges.calories;
  const range = dateRangeForPreset(preset, state.selectedDate);
  const resolution = preset === 'day' ? 'hour' : 'day';
  try {
    const data = await fetchJson(`/api/metrics/calories?start=${range.startDate}&end=${range.endDateExclusive}&resolution=${resolution}`);
    const summary = preset === 'day' ? data.summary : data.days.at(-1);
    root.innerHTML = `
      <section class="workspace-summary">
        <div><span>Total expenditure</span><strong>${numeric(summary?.totalKcal, ' kcal')}</strong></div>
        <dl>
          <div><dt>Active</dt><dd>${numeric(summary?.activeKcal, ' kcal')}</dd></div>
          <div><dt>Basal / resting</dt><dd>${numeric(summary?.basalKcal, ' kcal')}</dd></div>
          <div><dt>Intervals</dt><dd>${summary?.intervalCount ?? '—'}</dd></div>
          <div><dt>Coverage</dt><dd>${coverageHours(summary?.coverageSeconds)}</dd></div>
        </dl>
      </section>
      <section class="workspace-panel">
        <div class="section-title"><div><h2>${preset === 'day' ? 'Hourly expenditure' : 'Daily expenditure'}</h2><p><span class="legend-swatch active"></span>Active <span class="legend-swatch basal"></span>Basal</p></div></div>
        ${preset === 'day' ? hourlyCalories(data.intervals) : trendBars(data.days, 'totalKcal', (value) => `${Math.round(value ?? 0)} kcal`, true)}
      </section>`;
  } catch (error) {
    root.innerHTML = `<div class="workspace-empty error-copy">${escapeHtml(error.message)}</div>`;
  }
}

function localDateTimeInput(isoValue = new Date().toISOString()) {
  const date = new Date(isoValue);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function resetJournalForm() {
  $('#journalEntryId').value = '';
  $('#journalOccurredAt').value = localDateTimeInput(`${state.selectedDate}T18:00:00`);
  $('#journalBody').value = '';
  $('#journalTags').value = '';
  $('#cancelJournalEdit').hidden = true;
}

function renderJournalList(entries) {
  state.journal = entries;
  $('#journalCount').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  $('#journalListHeading').textContent = formatDate(state.selectedDate, { year: true });
  $('#journalList').innerHTML = entries.length
    ? entries
        .map(
          (entry) => `<article class="journal-entry" data-entry-id="${entry.id}">
            <div><time>${new Date(entry.occurredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><div class="tag-row">${entry.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div></div>
            <p>${escapeHtml(entry.body)}</p>
            <div class="entry-actions"><button type="button" data-edit-entry="${entry.id}">Edit</button><button type="button" data-delete-entry="${entry.id}">Delete</button></div>
          </article>`,
        )
        .join('')
    : '<p class="empty-copy">No context recorded for this date.</p>';
}

async function loadJournal() {
  const end = shiftDate(state.selectedDate, 1);
  resetJournalForm();
  try {
    renderJournalList(await fetchJson(`/api/journal?start=${state.selectedDate}&end=${end}`));
  } catch (error) {
    $('#journalList').innerHTML = `<p class="empty-copy error-copy">${escapeHtml(error.message)}</p>`;
  }
}

async function saveJournal(event) {
  event.preventDefault();
  const id = $('#journalEntryId').value;
  const body = $('#journalBody').value.trim();
  if (!body) return toast('Write a note before saving.');
  const tags = $('#journalTags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  const occurredAt = new Date($('#journalOccurredAt').value).toISOString();
  const payload = { civilDate: state.selectedDate, occurredAt, body, tags };
  try {
    await fetchJson(id ? `/api/journal/${id}` : '/api/journal', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    toast(id ? 'Context updated.' : 'Context saved.');
    await Promise.all([loadJournal(), loadToday()]);
  } catch (error) {
    toast(error.message);
  }
}

function editJournal(id) {
  const entry = state.journal.find((candidate) => candidate.id === id);
  if (!entry) return;
  $('#journalEntryId').value = entry.id;
  $('#journalOccurredAt').value = localDateTimeInput(entry.occurredAt);
  $('#journalBody').value = entry.body;
  $('#journalTags').value = entry.tags.join(', ');
  $('#cancelJournalEdit').hidden = false;
  $('#journalBody').focus();
}

async function deleteJournal(id) {
  if (!window.confirm('Delete this journal entry? Its encrypted revisions will also be removed.')) return;
  try {
    await fetchJson(`/api/journal/${id}`, { method: 'DELETE' });
    toast('Context deleted.');
    await Promise.all([loadJournal(), loadToday()]);
  } catch (error) {
    toast(error.message);
  }
}

async function loadExports() {
  clearTimeout(state.exportPoll);
  state.exportPoll = null;
  try {
    const jobs = await fetchJson('/api/exports');
    $('#exportList').innerHTML = jobs.length
      ? jobs
          .map(
            (job) => `<article class="export-job">
              <div><strong>${escapeHtml(job.fileName || `${job.exportType} export`)}</strong><small>${job.startDate}–${shiftDate(job.endDateExclusive, -1)}${job.errorMessage ? ` · ${escapeHtml(job.errorMessage)}` : ''}</small></div>
              <span data-status="${job.status}">${escapeHtml(job.status.replaceAll('_', ' '))}</span>
              ${job.status === 'completed' ? `<a class="button button-secondary button-compact" href="/api/exports/${job.id}/download">Download</a>` : ''}
            </article>`,
          )
          .join('')
      : '<p class="empty-copy">No export jobs yet.</p>';
    if (state.activeView === 'export' && exportPollingNeeded(jobs)) {
      state.exportPoll = setTimeout(loadExports, 800);
    }
  } catch (error) {
    $('#exportList').innerHTML = `<p class="empty-copy">${escapeHtml(error.message)}</p>`;
  }
}

async function createExport(event) {
  event.preventDefault();
  const exportType = $('input[name="exportType"]:checked').value;
  try {
    await fetchJson('/api/exports', {
      method: 'POST',
      body: JSON.stringify({
        startDate: $('#exportStart').value,
        endDateExclusive: $('#exportEnd').value,
        exportType,
        detailLevel: exportType === 'archive' ? 'full' : 'analysis',
        includeJournal: $('#includeJournal').checked,
        includePng: exportType === 'png' || $('#includePng').checked,
        metrics: ['sleep', 'heart', 'calories'],
      }),
    });
    toast('Export queued.');
    await loadExports();
  } catch (error) {
    toast(error.message);
  }
}

async function syncNow() {
  const button = $('#syncButton');
  button.disabled = true;
  setSyncState('loading', 'Sync queued');
  try {
    await fetchJson('/api/sync', { method: 'POST', body: JSON.stringify({ mode: 'recent' }) });
    toast('Recent sync queued.');
    setTimeout(loadToday, 1200);
  } catch (error) {
    toast(error.message);
    setSyncState('stale', 'Sync unavailable');
  } finally {
    button.disabled = false;
  }
}

async function setView(view) {
  if (view !== 'export') {
    clearTimeout(state.exportPoll);
    state.exportPoll = null;
  }
  state.activeView = view;
  $$('.app-view').forEach((element) => {
    element.hidden = element.dataset.view !== view;
  });
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.nav === view));
  window.history.replaceState({}, '', view === 'today' ? '/' : `/#${view}`);
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (view === 'today') await loadToday();
  if (view === 'sleep') await loadSleepWorkspace();
  if (view === 'heart') await loadHeartWorkspace();
  if (view === 'calories') await loadCalorieWorkspace();
  if (view === 'journal') await loadJournal();
  if (view === 'export') await loadExports();
}

function addSuggestedTag(tag) {
  const current = $('#journalTags').value.split(',').map((value) => value.trim()).filter(Boolean);
  if (!current.some((value) => value.toLowerCase() === tag.toLowerCase())) current.push(tag);
  $('#journalTags').value = current.join(', ');
}

$$('[data-nav]').forEach((control) => control.addEventListener('click', (event) => {
  event.preventDefault();
  setView(control.dataset.nav);
}));
$$('[data-open-view]').forEach((panel) => {
  const open = () => setView(panel.dataset.openView);
  panel.addEventListener('click', open);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
});
$$('[data-range-tabs]').forEach((group) => {
  group.addEventListener('click', (event) => {
    const button = event.target.closest('[data-range]');
    if (!button) return;
    $$('[data-range]', group).forEach((item) => item.classList.toggle('is-active', item === button));
    const metric = group.dataset.rangeTabs;
    state.ranges[metric] = button.dataset.range;
    if (metric === 'heart') loadHeartWorkspace();
    if (metric === 'calories') loadCalorieWorkspace();
  });
});

$('#sleepWorkspace').addEventListener('click', (event) => {
  const button = event.target.closest('[data-sleep-trend-period]');
  if (!button || button.dataset.sleepTrendPeriod === state.sleepTrendPeriod) return;
  state.sleepTrendPeriod = button.dataset.sleepTrendPeriod;
  loadSleepWorkspace();
});

$('#previousDate').addEventListener('click', () => {
  state.selectedDate = shiftDate(state.selectedDate, -1);
  updateDateControls();
  loadToday();
});
$('#nextDate').addEventListener('click', () => {
  if (state.selectedDate >= today) return;
  state.selectedDate = shiftDate(state.selectedDate, 1);
  updateDateControls();
  loadToday();
});
$('#todayButton').addEventListener('click', () => {
  state.selectedDate = today;
  updateDateControls();
  loadToday();
});
$('#datePicker').addEventListener('change', (event) => {
  if (!event.target.value || event.target.value > today) return;
  state.selectedDate = event.target.value;
  updateDateControls();
  loadToday();
});
$('#addContextButton').addEventListener('click', () => setView('journal'));
$('#syncButton').addEventListener('click', syncNow);
$('#logoutButton').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.assign('/login');
});
$('#journalForm').addEventListener('submit', saveJournal);
$('#cancelJournalEdit').addEventListener('click', resetJournalForm);
$('.tag-suggestions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-tag]');
  if (button) addSuggestedTag(button.dataset.tag);
});
$('#journalList').addEventListener('click', (event) => {
  const edit = event.target.closest('[data-edit-entry]');
  const remove = event.target.closest('[data-delete-entry]');
  if (edit) editJournal(edit.dataset.editEntry);
  if (remove) deleteJournal(remove.dataset.deleteEntry);
});
$('#exportForm').addEventListener('submit', createExport);

updateDateControls();
const initialView = window.location.hash.slice(1);
setView(['sleep', 'heart', 'calories', 'journal', 'export'].includes(initialView) ? initialView : 'today');
