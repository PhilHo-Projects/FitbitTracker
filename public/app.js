import {
  buildTimelineSegments,
  formatDuration,
  scaleWeekDurations,
  stagePercentages,
} from './sleep-ui.js';

const stageOrder = ['awake', 'light', 'deep', 'rem', 'asleep', 'restless'];
const knownStages = new Set(stageOrder);
const $ = (selector) => document.querySelector(selector);

const elements = {
  connectionStatus: $('#connectionStatus'),
  connectionStatusText: $('#connectionStatusText'),
  refreshButton: $('#refreshButton'),
  refreshSpinner: $('#refreshSpinner'),
  refreshLabel: $('#refreshLabel'),
  logoutButton: $('#logoutButton'),
  notice: $('#notice'),
  loadingState: $('#loadingState'),
  emptyState: $('#emptyState'),
  emptyRefreshButton: $('#emptyRefreshButton'),
  dashboardContent: $('#dashboardContent'),
  latestDate: $('#latestDate'),
  latestDuration: $('#latestDuration'),
  bedtimeValue: $('#bedtimeValue'),
  wakeValue: $('#wakeValue'),
  sleepTypeBadge: $('#sleepTypeBadge'),
  stageCaption: $('#stageCaption'),
  stageTimeline: $('#stageTimeline'),
  stageLegend: $('#stageLegend'),
  averageDuration: $('#averageDuration'),
  averageAsleep: $('#averageAsleep'),
  averageEfficiency: $('#averageEfficiency'),
  nightsCount: $('#nightsCount'),
  rangeLabel: $('#rangeLabel'),
  trendAverage: $('#trendAverage'),
  weekChart: $('#weekChart'),
  nightHistory: $('#nightHistory'),
  napsPanel: $('#napsPanel'),
  napsCount: $('#napsCount'),
  napHistory: $('#napHistory'),
  syncMeta: $('#syncMeta'),
  rawResponse: $('#rawResponse'),
};

let hasRendered = false;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stageName(type) {
  const names = {
    awake: 'Awake',
    light: 'Light',
    deep: 'Deep',
    rem: 'REM',
    asleep: 'Asleep',
    restless: 'Restless',
  };
  return names[type] || String(type || 'Unknown').replaceAll('_', ' ');
}

function safeStage(type) {
  return knownStages.has(type) ? type : 'unspecified';
}

function formatDate(date, options = {}) {
  if (!date) return '—';
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: options.compact ? 'short' : 'long',
    month: 'short',
    day: 'numeric',
  });
}

function parseOffsetSeconds(offset) {
  const value = String(offset || '');
  return value.endsWith('s') && Number.isFinite(Number(value.slice(0, -1)))
    ? Number(value.slice(0, -1))
    : 0;
}

function formatCivilTime(civilDateTime) {
  const time = civilDateTime?.time;
  if (!time) return null;
  const date = new Date(Date.UTC(2026, 0, 1, Number(time.hours || 0), Number(time.minutes || 0)));
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function formatLocalTime(timestamp, utcOffset, civilDateTime) {
  const civilTime = formatCivilTime(civilDateTime);
  if (civilTime) return civilTime;

  const physicalTime = Date.parse(timestamp);
  if (!Number.isFinite(physicalTime)) return '—';
  const shifted = new Date(physicalTime + parseOffsetSeconds(utcOffset) * 1000);
  return shifted.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function setConnectionState(state, text) {
  elements.connectionStatus.dataset.state = state;
  elements.connectionStatusText.textContent = text;
}

function showNotice(kind, message) {
  elements.notice.dataset.kind = kind;
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function setLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshSpinner.hidden = !loading;
  elements.refreshButton.querySelector('.button-icon').hidden = loading;
  elements.refreshLabel.textContent = loading ? 'Fetching…' : 'Refresh sleep';

  if (!hasRendered) {
    elements.loadingState.hidden = !loading;
    elements.dashboardContent.hidden = true;
    elements.emptyState.hidden = true;
  }
}

function extractSleepData(payload) {
  const upstream = payload?.data;
  if (upstream?.nights && upstream?.summary) return upstream;
  if (upstream?.data?.nights && upstream?.data?.summary) return upstream.data;
  if (upstream?.sleep?.nights && upstream?.sleep?.summary) return upstream.sleep;
  return null;
}

function summarySegments(night) {
  return stageOrder
    .map((type) => ({
      type,
      durationMinutes: Number(night.stageSummary?.[type]?.minutes || 0),
    }))
    .filter((stage) => stage.durationMinutes > 0);
}

function renderTimeline(night) {
  const hasMeasuredTimeline = Array.isArray(night.stages) && night.stages.length > 0;
  const segments = buildTimelineSegments(
    hasMeasuredTimeline ? night.stages : summarySegments(night),
  );
  const percentages = stagePercentages(night.stageSummary, night.durationMinutes);

  elements.stageTimeline.innerHTML = segments.length
    ? segments
        .map(
          (segment) => `
            <span
              class="timeline-segment"
              data-stage="${safeStage(segment.type)}"
              style="width:${segment.widthPercent}%"
              title="${escapeHtml(stageName(segment.type))}: ${escapeHtml(formatDuration(segment.durationMinutes))}"
            ></span>
          `,
        )
        .join('')
    : '<span class="timeline-empty">No stage breakdown available</span>';

  const ariaSummary = segments
    .map((segment) => `${stageName(segment.type)} ${formatDuration(segment.durationMinutes)}`)
    .join(', ');
  elements.stageTimeline.setAttribute(
    'aria-label',
    ariaSummary ? `Sleep stages: ${ariaSummary}` : 'No sleep stage breakdown available',
  );
  elements.stageCaption.textContent = hasMeasuredTimeline
    ? 'Measured in sequence across the night'
    : 'Summary totals; exact stage sequence unavailable';

  const summaryEntries = stageOrder.filter((type) => night.stageSummary?.[type]);
  elements.stageLegend.innerHTML = summaryEntries.length
    ? summaryEntries
        .map((type) => {
          const minutes = Number(night.stageSummary[type].minutes || 0);
          return `
            <div class="stage-stat">
              <span class="stage-key"><i data-stage="${safeStage(type)}"></i>${escapeHtml(stageName(type))}</span>
              <strong>${escapeHtml(formatDuration(minutes))}</strong>
              <small>${escapeHtml(percentages[type] ?? 0)}%</small>
            </div>
          `;
        })
        .join('')
    : '<p class="muted-copy">Google Health returned this sleep without stage totals.</p>';
}

function renderLatest(night) {
  elements.latestDate.textContent = formatDate(night.date);
  elements.latestDuration.textContent = formatDuration(night.durationMinutes);
  elements.bedtimeValue.textContent = formatLocalTime(
    night.startTime,
    night.startUtcOffset,
    night.civilStartTime,
  );
  elements.wakeValue.textContent = formatLocalTime(
    night.endTime,
    night.endUtcOffset,
    night.civilEndTime,
  );
  elements.sleepTypeBadge.textContent =
    night.type === 'stages' ? 'Stage sleep' : night.type === 'classic' ? 'Classic sleep' : 'Sleep';
  renderTimeline(night);
}

function renderSummary(data) {
  const summary = data.summary || {};
  elements.averageDuration.textContent = formatDuration(summary.averageDurationMinutes);
  elements.averageAsleep.textContent = formatDuration(summary.averageMinutesAsleep);
  elements.averageEfficiency.textContent = `${Number(summary.averageEfficiency || 0).toFixed(1)}%`;
  elements.nightsCount.textContent = String(summary.nightsCount ?? data.nights.length);
  elements.trendAverage.textContent = `Average ${formatDuration(summary.averageDurationMinutes)}`;
  elements.rangeLabel.textContent =
    data.range?.startDate && data.range?.endDateExclusive
      ? `${data.range.startDate} to ${data.range.endDateExclusive}`
      : 'latest seven dates';
}

function renderWeekChart(nights) {
  const chronological = [...nights].reverse();
  const bars = scaleWeekDurations(chronological);
  elements.weekChart.innerHTML = bars
    .map((bar) => {
      const visibleHeight = bar.durationMinutes > 0 ? Math.max(7, bar.heightPercent) : 0;
      return `
        <div class="week-column">
          <span class="week-duration">${escapeHtml(formatDuration(bar.durationMinutes))}</span>
          <div class="week-bar-track">
            <span
              class="week-bar"
              style="height:${visibleHeight}%"
              title="${escapeHtml(formatDate(bar.date))}: ${escapeHtml(formatDuration(bar.durationMinutes))}"
            ></span>
          </div>
          <span class="week-day">${escapeHtml(formatDate(bar.date, { compact: true }).split(',')[0])}</span>
        </div>
      `;
    })
    .join('');
}

function compactStages(night) {
  const stages = stageOrder.filter((type) => Number(night.stageSummary?.[type]?.minutes || 0) > 0);
  if (!stages.length) {
    return '<span class="muted-copy">No stages</span>';
  }
  return `
    <span class="stage-mini-strip" aria-label="${escapeHtml(stages.map(stageName).join(', '))}">
      ${stages
        .map(
          (type) =>
            `<i data-stage="${safeStage(type)}" title="${escapeHtml(stageName(type))}"></i>`,
        )
        .join('')}
    </span>
  `;
}

function renderHistory(nights) {
  elements.nightHistory.innerHTML = nights
    .map(
      (night) => `
        <article class="history-row">
          <div class="history-primary">
            <strong>${escapeHtml(formatDate(night.date, { compact: true }))}</strong>
            <small>${escapeHtml(
              `${formatLocalTime(night.startTime, night.startUtcOffset, night.civilStartTime)} – ${formatLocalTime(
                night.endTime,
                night.endUtcOffset,
                night.civilEndTime,
              )}`,
            )}</small>
          </div>
          <span data-label="Period">${escapeHtml(formatDuration(night.durationMinutes))}</span>
          <span data-label="Asleep">${escapeHtml(formatDuration(night.minutesAsleep))}</span>
          <span data-label="Efficiency">${escapeHtml(Number(night.efficiency || 0).toFixed(1))}%</span>
          <span data-label="Stages">${compactStages(night)}</span>
        </article>
      `,
    )
    .join('');
}

function renderNaps(naps) {
  elements.napsPanel.hidden = !naps.length;
  if (!naps.length) return;

  elements.napsCount.textContent = `${naps.length} ${naps.length === 1 ? 'nap' : 'naps'}`;
  elements.napHistory.innerHTML = naps
    .map(
      (nap) => `
        <article class="nap-row">
          <span>
            <strong>${escapeHtml(formatDate(nap.date, { compact: true }))}</strong>
            <small>${escapeHtml(
              formatLocalTime(nap.startTime, nap.startUtcOffset, nap.civilStartTime),
            )}</small>
          </span>
          <strong>${escapeHtml(formatDuration(nap.durationMinutes))}</strong>
        </article>
      `,
    )
    .join('');
}

function renderSleep(data, payload) {
  const nights = Array.isArray(data.nights) ? data.nights : [];
  const naps = Array.isArray(data.naps) ? data.naps : [];
  hasRendered = true;
  elements.loadingState.hidden = true;

  if (!nights.length) {
    elements.dashboardContent.hidden = true;
    elements.emptyState.hidden = false;
    setConnectionState('ok', 'Connected · no sleep found');
  } else {
    elements.emptyState.hidden = true;
    elements.dashboardContent.hidden = false;
    renderLatest(data.latest || nights[0]);
    renderSummary({ ...data, nights });
    renderWeekChart(nights);
    renderHistory(nights);
    renderNaps(naps);
    setConnectionState('ok', `Connected · ${nights.length} ${nights.length === 1 ? 'night' : 'nights'}`);
  }

  const generatedAt = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString()
    : 'time unavailable';
  elements.syncMeta.textContent = `Generated ${generatedAt} · dashboard proxy ${payload.elapsedMs ?? '—'} ms`;
  elements.rawResponse.textContent = JSON.stringify(payload, null, 2);
}

function upstreamFailure(payload) {
  const upstream = payload?.data;
  if (upstream?.ok === false) {
    return upstream.message || upstream.error || 'The n8n workflow could not fetch sleep data.';
  }
  const failedSection = Object.values(upstream?.sections || {}).find(
    (section) => section?.ok === false,
  );
  return failedSection?.message || failedSection?.error || null;
}

async function fetchSleep() {
  setLoading(true);
  showNotice('', '');
  setConnectionState('loading', 'Fetching Google Health');

  try {
    const response = await fetch('/api/sleep', { method: 'POST' });
    const payload = await response.json().catch(() => ({
      ok: false,
      message: `Dashboard API returned HTTP ${response.status}`,
    }));
    elements.rawResponse.textContent = JSON.stringify(payload, null, 2);

    if (response.status === 401) {
      window.location.assign('/login');
      return;
    }
    if (!response.ok || !payload.ok) {
      throw new Error([payload.message, payload.hint].filter(Boolean).join(' — ') || 'Sync failed');
    }

    const sectionError = upstreamFailure(payload);
    if (sectionError) {
      throw new Error(sectionError);
    }

    const data = extractSleepData(payload);
    if (!data) {
      throw new Error('n8n returned an unexpected sleep-data shape. Open diagnostics for details.');
    }

    renderSleep(data, payload);
  } catch (error) {
    elements.loadingState.hidden = true;
    if (!hasRendered) {
      elements.emptyState.hidden = true;
      elements.dashboardContent.hidden = true;
    }
    setConnectionState('error', 'Sync needs attention');
    showNotice('error', error?.message || String(error));
    elements.syncMeta.textContent = 'Latest sync failed';
  } finally {
    setLoading(false);
  }
}

async function logout() {
  elements.logoutButton.disabled = true;
  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.assign('/login');
  }
}

elements.refreshButton.addEventListener('click', fetchSleep);
elements.emptyRefreshButton.addEventListener('click', fetchSleep);
elements.logoutButton.addEventListener('click', logout);

fetchSleep();
