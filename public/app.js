import {
  civilDateInTimeZone,
  dateRangeForPreset,
  exportPollingNeeded,
  formatDuration,
  heartDetailNotice,
  isLocalDevelopmentHost,
  sleepStageBreakdown,
} from './health-ui.js';
import { connectorBannerMessage, renderConnectorStatus, connectorCallbackMessage, syncJobOutcome } from './settings-ui.js';
import { renderOxygenNight, renderOxygenTrend, renderOxygenCard } from './oxygen-ui.js';
import { createSleepWorkspace, sleepDuration, recordedTime } from './sleep-workspace.js';
import { readWorkspaceLocation, workspaceUrl } from './sleep-navigation.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localDevelopment = isLocalDevelopmentHost(window.location.hostname);
$('#environmentBanner').hidden = !localDevelopment;
document.body.classList.toggle('is-local-development', localDevelopment);
let profileTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let today = civilDateInTimeZone(new Date(), profileTimezone);
const stageNames = { awake: 'Awake', light: 'Light', deep: 'Deep', rem: 'REM' };
const state = {
  selectedDate: today,
  activeView: 'sleep',
  sleepSelection: { date: null, sessionId: null, sources: {} },
  ranges: { heart: 'day', calories: 'day', oxygen: 'day' },
  oxygenSelection: {},
  oxygenRequestVersion: 0,
  oxygenData: null,
  dashboard: null,
  newestMeasurementAt: null,
  journal: [],
  exportPoll: null,
  syncPoll: null,
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
    throw Object.assign(new Error(payload.message || `Request failed with HTTP ${response.status}`), { status: response.status });
  }
  return Object.hasOwn(payload, 'data') ? payload.data : payload;
}

async function refreshConnector() {
  let data = null;
  try {
    data = await fetchJson('/api/connectors/google');
    state.newestMeasurementAt = data.newestMeasurementAt ?? null;
  } catch {
    // Never leave a previous healthy status visible after a failed health check.
  }
  renderConnectorStatus(document, data);
  const banner = document.getElementById('connectorBanner');
  const message = connectorBannerMessage(data, { newestMeasurementAt: state.newestMeasurementAt });
  banner.textContent = message ?? '';
  banner.hidden = !message;
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
  if (data.timezone) profileTimezone = data.timezone;
  $('#todayOxygen').innerHTML = renderOxygenCard(data.oxygenSaturation);
  state.dashboard = data;
  state.newestMeasurementAt = data.newestMeasurementAt ?? null;
  state.journal = journal;
  const sleep = data.sleep;
  $('#todaySleepEmpty').hidden = Boolean(sleep);
  $('#todaySleepData').hidden = !sleep;
  if (sleep) {
    $('#sleepDuration').textContent = sleepDuration(sleep.minutesAsleep);
    $('#sleepWindow').textContent = `${recordedTime(sleep.startTime,sleep.startOffsetSeconds,profileTimezone)}–${recordedTime(sleep.endTime,sleep.endOffsetSeconds,profileTimezone)}`;
    $('#sleepAsleep').textContent = sleepDuration(sleep.durationMinutes);
    $('#sleepEfficiency').textContent = data.sleepAssessment?.metrics.efficiency.value == null ? '—' : `${Math.round(data.sleepAssessment.metrics.efficiency.value)}%`;
    $('#todaySleepAssessment').textContent = data.sleepAssessment?.headline ?? '';
    $('#todaySleepNotes').textContent = data.sleepAssessment?.notes.join(' ') ?? '';
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
    await refreshConnector();
  } catch (error) {
    $('#todayLoading').hidden = true;
    showNotice(error.message);
  }
}

async function loadSleepWorkspace() { await sleepWorkspace.load(state.sleepSelection); }

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
    const summary = preset === 'day' ? data.summary : data.periodSummary;
    const points = preset === 'day' && data.resolution === 'five-minute' ? data.points : data.days;
    const detailNotice = heartDetailNotice(data);
    root.innerHTML = `
      <section class="workspace-summary">
        <div><span>Resting heart rate</span><strong>${numeric(summary?.restingBpm ?? summary?.averageDailyRestingBpm, ' bpm')}</strong></div>
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
        ${detailNotice ? `<p class="workspace-empty">${escapeHtml(detailNotice)}</p>` : ''}
        ${rangePlot(points, preset === 'day' && data.resolution === 'five-minute')}
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
        includeSleepCheckIns: $('#includeSleepCheckIns').checked,
        includePng: exportType === 'png' || $('#includePng').checked,
        metrics: $$('input[name="exportMetric"]:checked').map(input => input.value),
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
    const job = await fetchJson('/api/sync', { method: 'POST', body: JSON.stringify({ mode: 'recent' }) });
    toast('Recent sync queued.');
    clearTimeout(state.syncPoll);
    monitorSync(job.id);
  } catch (error) {
    toast(error.message);
    setSyncState('stale', 'Sync unavailable');
  } finally {
    button.disabled = false;
  }
}

async function monitorSync(id, attempts = 0) {
  try {
    const result = syncJobOutcome(await fetchJson('/api/sync/status'), id);
    if (result !== 'pending') {
      if (state.activeView === 'today') await loadToday();
      else if (state.activeView === 'oxygen') await loadOxygenWorkspace();
      else await refreshConnector();
      if (result === 'failed') {
        setSyncState('stale', 'Sync needs attention');
        toast('Sync finished with errors. Check Settings for the connection state.');
      } else toast('Sync complete.');
      return;
    }
    if (attempts >= 120) {
      toast('Sync is still running in the background.');
      return;
    }
    state.syncPoll = setTimeout(() => monitorSync(id, attempts + 1), 5000);
  } catch {
    setSyncState('stale', 'Sync status unavailable');
    await refreshConnector();
  }
}

async function setView(view, { historyMode = 'push' } = {}) {
  if (view !== 'export') {
    clearTimeout(state.exportPoll);
    state.exportPoll = null;
  }
  state.activeView = view;
  if (view !== 'sleep') sleepWorkspace.cancel();
  if (view !== 'oxygen') state.oxygenRequestVersion++;
  $$('.app-view').forEach((element) => {
    element.hidden = element.dataset.view !== view;
  });
  $$('.nav-item').forEach((item) => item.classList.toggle('is-active', item.dataset.nav === view || item.dataset.nav === 'more' && ['heart','oxygen','calories','export','settings'].includes(view)));
  if (historyMode !== 'none') window.history[historyMode === 'replace' ? 'replaceState' : 'pushState']({}, '', workspaceUrl(view,state.selectedDate,state.sleepSelection));
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (view === 'today') await loadToday();
  if (view === 'sleep') await loadSleepWorkspace();
  if (view === 'heart') await loadHeartWorkspace();
  if (view === 'oxygen') await loadOxygenWorkspace();
  if (view === 'calories') await loadCalorieWorkspace();
  if (view === 'journal') await loadJournal();
  if (view === 'export') await loadExports();
  if (view !== 'today') await refreshConnector();
}

async function loadOxygenWorkspace() {
  const version = ++state.oxygenRequestVersion;
  const date = state.selectedDate;
  const preset = state.ranges.oxygen;
  const root = $('#oxygenWorkspace');
  $('#oxygenDate').value = date;
  $('#oxygenDate').max = today;
  $('#oxygenNext').disabled = date >= today;
  $('#oxygenToday').disabled = date === today;
  const range = dateRangeForPreset(preset, date);
  const query = new URLSearchParams({ start: range.startDate, end: range.endDateExclusive, resolution: preset === 'day' ? 'night' : 'day', ...state.oxygenSelection });
  const previous = state.oxygenQuery === query.toString() ? state.oxygenData : null;
  root.setAttribute('aria-busy', 'true');
  root.innerHTML = '<p class="workspace-empty" role="status">Loading blood oxygen…</p>' + (previous ? preset === 'day' ? renderOxygenNight(previous) : renderOxygenTrend(previous) : '');
  try {
    const data = await fetchJson(`/api/metrics/oxygen?${query}`);
    if (version !== state.oxygenRequestVersion) return;
    state.oxygenData = data;
    state.oxygenQuery = query.toString();
    root.innerHTML = preset === 'day' ? renderOxygenNight(data) : renderOxygenTrend(data);
  } catch (error) {
    if (version !== state.oxygenRequestVersion) return;
    if (error.status === 400 && Object.keys(state.oxygenSelection).length) {
      state.oxygenSelection = {};
      await loadOxygenWorkspace();
      return;
    }
    root.innerHTML = `<p class="oxygen-notice" role="alert">${escapeHtml(error.message)}${previous ? ' Showing the last loaded view.' : ''}</p><button type="button" class="button button-secondary" data-oxygen-retry>Retry</button>` + (previous ? preset === 'day' ? renderOxygenNight(previous) : renderOxygenTrend(previous) : '');
  } finally {
    if (version === state.oxygenRequestVersion) root.setAttribute('aria-busy', 'false');
  }
}

function selectOxygenDate(date) {
  if (!date || date > today) return;
  state.selectedDate = date;
  state.oxygenSelection = {};
  updateDateControls();
  loadOxygenWorkspace();
}

$('#oxygenPrevious').addEventListener('click', () => selectOxygenDate(shiftDate(state.selectedDate, -1)));
$('#oxygenNext').addEventListener('click', () => selectOxygenDate(shiftDate(state.selectedDate, 1)));
$('#oxygenToday').addEventListener('click', () => selectOxygenDate(today));
$('#oxygenDate').addEventListener('change', event => selectOxygenDate(event.target.value));
$('#oxygenWorkspace').addEventListener('change', event => {
  const type = event.target.dataset.oxygenSource;
  if (!type) return;
  if (event.target.value) state.oxygenSelection[`${type}Source`] = event.target.value;
  else delete state.oxygenSelection[`${type}Source`];
  loadOxygenWorkspace();
});
function oxygenPointFocus(event) {
  const point = event.target.closest('[data-oxygen-point]');
  if (point && $('#oxygenReading')) $('#oxygenReading').textContent = point.dataset.oxygenPoint;
}
$('#oxygenWorkspace').addEventListener('focusin', oxygenPointFocus);
$('#oxygenWorkspace').addEventListener('pointerover', oxygenPointFocus);
$('#oxygenWorkspace').addEventListener('click', event => {
  oxygenPointFocus(event);
  const date = event.target.closest('[data-oxygen-date]')?.dataset.oxygenDate;
  if (date) {
    state.ranges.oxygen = 'day';
    $$('[data-range-tabs="oxygen"] [data-range]').forEach(button => {
      button.classList.toggle('is-active', button.dataset.range === 'day');
      button.setAttribute('aria-pressed', String(button.dataset.range === 'day'));
    });
    selectOxygenDate(date);
  }
  if (event.target.closest('[data-oxygen-retry]')) loadOxygenWorkspace();
  const page = event.target.closest('[data-oxygen-page]');
  if (page && state.oxygenData) $('#oxygenWorkspace').innerHTML = renderOxygenNight(state.oxygenData, { readingPage: Number(page.dataset.oxygenPage) });
});
$('#oxygenWorkspace').addEventListener('keydown', event => {
  if (event.target.matches('circle[data-oxygen-date]') && ['Enter', ' '].includes(event.key)) {
    event.preventDefault(); event.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});
$('#oxygenExport').addEventListener('click', () => {
  const range = dateRangeForPreset(state.ranges.oxygen, state.selectedDate);
  $('#exportStart').value = state.ranges.oxygen === 'day' ? shiftDate(state.selectedDate, -1) : range.startDate;
  $('#exportEnd').value = range.endDateExclusive;
  $$('input[name="exportMetric"]').forEach(input => { input.checked = input.value === 'oxygen'; });
  setView('export');
});

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
  const open = () => {
    if (panel.dataset.openView === 'sleep') state.sleepSelection = { ...state.sleepSelection, date: state.selectedDate, sessionId: null };
    setView(panel.dataset.openView);
  };
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
    $$('[data-range]', group).forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    const metric = group.dataset.rangeTabs;
    state.ranges[metric] = button.dataset.range;
    if (metric === 'heart') loadHeartWorkspace();
    if (metric === 'calories') loadCalorieWorkspace();
    if (metric === 'oxygen') { state.oxygenSelection = {}; loadOxygenWorkspace(); }
  });
});

$('#previousDate').addEventListener('click', () => {
  state.selectedDate = shiftDate(state.selectedDate, -1);
  updateDateControls();
  setView('today');
});
$('#nextDate').addEventListener('click', () => {
  if (state.selectedDate >= today) return;
  state.selectedDate = shiftDate(state.selectedDate, 1);
  updateDateControls();
  setView('today');
});
$('#todayButton').addEventListener('click', () => {
  state.selectedDate = today;
  updateDateControls();
  setView('today');
});
$('#datePicker').addEventListener('change', (event) => {
  if (!event.target.value || event.target.value > today) return;
  state.selectedDate = event.target.value;
  updateDateControls();
  setView('today');
});
$('#addContextButton').addEventListener('click', () => setView('journal'));
$('#syncButton').addEventListener('click', syncNow);
$('#connectorConnect')?.addEventListener('click', async () => {
  try {
    const data = await fetchJson('/api/connectors/google/authorize', { method: 'POST' });
    window.location.assign(data.url);
  } catch (error) {
    toast(error.message);
  }
});
$('#connectorDisconnect')?.addEventListener('click', async () => {
  try {
    await fetchJson('/api/connectors/google/disconnect', { method: 'POST' });
    await refreshConnector();
  } catch (error) {
    toast(error.message);
  }
});
$('#logoutButton').addEventListener('click', async () => {
  await fetch('/api/auth/sign-out', { method: 'POST' });
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

const sleepWorkspace = createSleepWorkspace({
  root: $('#sleepWorkspace'), fetchJson, notify: toast,
  navigate(selection) { state.sleepSelection = selection; if(selection.date)state.selectedDate=selection.date; setView('sleep'); },
  onResolved(report) {
    if(report.timezone)profileTimezone=report.timezone;
    if(report.date) { state.selectedDate=report.date; state.sleepSelection={...state.sleepSelection,date:report.date,sessionId:report.session?.id??null}; }
    if(state.activeView==='sleep')window.history.replaceState({},'',workspaceUrl('sleep',state.selectedDate,state.sleepSelection));
    updateDateControls();
  },
});
function restoreLocation(historyMode='none') {
  const route=readWorkspaceLocation(window.location);
  state.sleepSelection=route.sleepSelection;
  if(route.date)state.selectedDate=route.date;
  updateDateControls();
  setView(route.view,{historyMode});
}
window.addEventListener('popstate',()=>restoreLocation());
window.addEventListener('hashchange',()=>{const route=readWorkspaceLocation(window.location);if(route.view!==state.activeView)restoreLocation();});
const callbackMessage = window.location.pathname === '/settings' ? connectorCallbackMessage(window.location.search) : null;
if (callbackMessage) toast(callbackMessage);
restoreLocation('replace');
// Background syncs and token expiry must become visible without a page reload.
setInterval(() => { if (!document.hidden) refreshConnector(); }, 60_000);
