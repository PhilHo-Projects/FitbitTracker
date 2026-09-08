import { oxygenCivilDate, oxygenInstantNanoseconds, floorDivide } from '../metrics/oxygen-time.js';
import { summarizeOxygenSamples, buildOxygenSegments, selectOxygenWindow } from '../metrics/oxygen-statistics.js';

const oxygenMetrics = ['oxygen-saturation', 'daily-oxygen-saturation'];
const number = value => value == null ? null : Number(value);
const iso = value => value ? new Date(value).toISOString() : null;
const dateOnly = value => typeof value === 'string' ? value.slice(0, 10) : iso(value)?.slice(0, 10);
const badRequest = message => Object.assign(new Error(message), { status: 400 });
export const shiftOxygenDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

export function validateOxygenRange(startDate, endDateExclusive, resolution = 'day', selection = {}) {
  try { oxygenCivilDate(startDate); oxygenCivilDate(endDateExclusive); } catch { throw badRequest('Oxygen dates must be valid calendar dates'); }
  const days = (Date.parse(endDateExclusive) - Date.parse(startDate)) / 86400000;
  if (days < 1 || days > 366 || !['day', 'night'].includes(resolution) || (resolution === 'night' && days !== 1)) {
    throw badRequest('Oxygen range must be 1–366 days; night detail requires one day');
  }
  for (const key of ['sampleSource', 'dailySource']) {
    if (selection[key] != null && (typeof selection[key] !== 'string' || !/^[a-f0-9]{64}$/.test(selection[key]))) throw badRequest('Invalid oxygen source selector');
  }
}

// Completeness is evidence from a connected, completed pagination chain, not job status alone.
export function oxygenFetchStatus(rows, { startDate, endDateExclusive }) {
  const windows = new Map();
  for (const row of rows) {
    const start = dateOnly(row.start_date), end = dateOnly(row.end_date_exclusive);
    if (start >= endDateExclusive || end <= startDate) continue;
    const key = `${row.sync_job_id}:${start}:${end}`;
    if (!windows.has(key)) windows.set(key, { startDate: start, endDateExclusive: end, rows: [] });
    windows.get(key).rows.push(row);
  }
  const successful = [];
  let latest = null;
  for (const window of windows.values()) {
    const pages = new Map(window.rows.map(row => [row.page_token || '', row]));
    let token = '', ended = false;
    const visited = new Set();
    while (!visited.has(token)) {
      const page = pages.get(token);
      if (!page || page.status !== 'completed') break;
      visited.add(token);
      if (!page.next_page_token) { ended = true; break; }
      token = page.next_page_token;
    }
    const complete = ended && visited.size === window.rows.length;
    const at = window.rows.map(row => iso(row.job_created_at ?? row.created_at)).filter(Boolean).sort().at(-1);
    const finished = window.rows.map(row => iso(row.completed_at)).filter(Boolean).sort().at(-1) ?? null;
    const status = window.rows.some(row => row.status === 'failed') ? 'failed'
      : complete ? 'completed' : window.rows.some(row => row.status === 'running') ? 'running' : 'queued';
    if (!latest || at >= latest.at) latest = { at, status };
    if (complete) successful.push({ startDate: window.startDate, endDateExclusive: window.endDateExclusive, finishedAt: finished });
  }
  successful.sort((a, b) => a.startDate.localeCompare(b.startDate));
  const fetchedRanges = [];
  for (const range of successful) {
    const last = fetchedRanges.at(-1);
    if (last && range.startDate <= last.endDateExclusive) last.endDateExclusive = last.endDateExclusive > range.endDateExclusive ? last.endDateExclusive : range.endDateExclusive;
    else fetchedRanges.push({ startDate: range.startDate, endDateExclusive: range.endDateExclusive });
  }
  return { lastAttemptStatus: latest?.status ?? 'not-synced', lastAttemptAt: latest?.at ?? null,
    lastSuccessfulFetchAt: successful.map(row => row.finishedAt).filter(Boolean).sort().at(-1) ?? null,
    fetchComplete: fetchedRanges.some(range => range.startDate <= startDate && range.endDateExclusive >= endDateExclusive),
    errorCode: latest?.status === 'failed' ? 'OXYGEN_SYNC_FAILED' : null,
    requestedRange: { startDate, endDateExclusive }, fetchedRanges };
}

export function oxygenDailyRow(row) {
  return { providerKey: row.provider_key, providerId: row.provider_id, sourceKey: row.source_key,
    civilDate: dateOnly(row.civil_date_text ?? row.civil_date), averagePercentage: number(row.average_percentage),
    lowerBoundPercentage: number(row.lower_bound_percentage), upperBoundPercentage: number(row.upper_bound_percentage),
    standardDeviationPercentage: number(row.standard_deviation_percentage), qualityFlags: row.quality_flags ?? [] };
}

function sourceGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.source_key)) {
      const metadata = row.source_metadata ?? {};
      const label = metadata.device?.displayName || metadata.device?.model || metadata.application?.displayName || 'Source not identified';
      groups.set(row.source_key, { key: row.source_key, label: typeof label === 'string' ? label : 'Source not identified', recordCount: 0 });
    }
    groups.get(row.source_key).recordCount++;
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function chooseSource(sources, requested) {
  if (requested != null && !sources.some(source => source.key === requested)) throw badRequest('Oxygen source is unavailable in this range');
  return requested ?? (sources.length === 1 ? sources[0].key : null);
}

function dailySelection(rows, sourceKey) {
  const dailyCandidates = rows.map(oxygenDailyRow);
  const selected = sourceKey ? dailyCandidates.filter(row => row.sourceKey === sourceKey) : [];
  return { dailyCandidates, dailySummary: selected.length === 1 ? selected[0] : null, ambiguous: selected.length > 1 };
}

function dataState(summary, count, selectionRequired, complete) {
  return selectionRequired ? 'source-selection-required' : summary && count ? 'ready' : summary ? 'summary-only'
    : count ? 'samples-only' : complete ? 'empty' : 'not-synced';
}

export function compactOxygenDay(day) {
  const { date, dataState, dailySummary, sampleSummary, availability, sync, newestSampleAt, qualityFlags } = day;
  return { date, dataState, dailySummary, sampleSummary, availability, sync, newestSampleAt, qualityFlags };
}

// Bind six fractional digits, with one microsecond of margin around PostgreSQL's projection.
function sqlBoundary(timestamp, deltaMicros) {
  const micros = floorDivide(oxygenInstantNanoseconds(timestamp), 1000n) + BigInt(deltaMicros);
  const seconds = floorDivide(micros, 1000000n);
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${String(micros - seconds * 1000000n).padStart(6, '0')}Z`;
}

function localDate(instant, offset) {
  return new Date(Date.parse(instant) + (offset ?? 0) * 1000).toISOString().slice(0, 10);
}

export function createOxygenRepository(pool) {
  const dateProjection = pool.constructor?.name === 'MemPg' ? 'civil_date' : 'civil_date::text';
  async function accountTimezone(accountId) {
    return accountId ? (await pool.query('SELECT timezone FROM source_accounts WHERE id = $1', [accountId])).rows[0]?.timezone ?? 'America/Toronto' : 'America/Toronto';
  }
  async function dailyRows(accountId, range) {
    return accountId ? (await pool.query(`SELECT *, ${dateProjection} AS civil_date_text FROM oxygen_saturation_daily_summaries
      WHERE source_account_id = $1 AND civil_date >= $2 AND civil_date < $3 ORDER BY civil_date, provider_key`,
    [accountId, range.startDate, range.endDateExclusive])).rows : [];
  }
  async function syncRows(accountId, range) {
    return accountId ? (await pool.query(`SELECT c.*, j.created_at AS job_created_at FROM sync_chunks c
      JOIN sync_jobs j ON j.id = c.sync_job_id WHERE j.source_account_id = $1
      AND c.metric IN ('oxygen-saturation', 'daily-oxygen-saturation')
      AND c.start_date < $3 AND c.end_date_exclusive > $2`, [accountId, range.startDate, range.endDateExclusive])).rows : [];
  }
  const repository = {
    async getDay(accountId, date, selection = {}) {
      const range = { startDate: date, endDateExclusive: shiftOxygenDate(oxygenCivilDate(date), 1) };
      validateOxygenRange(range.startDate, range.endDateExclusive, 'night', selection);
      const [timezone, daily, sleep] = await Promise.all([accountTimezone(accountId), dailyRows(accountId, range), accountId
        ? pool.query(`SELECT * FROM sleep_sessions WHERE source_account_id = $1 AND civil_date = $2 AND is_nap = false
          ORDER BY duration_seconds DESC, id LIMIT 1`, [accountId, date]).then(result => result.rows[0]) : null]);
      let sleepSession = null;
      if (sleep) {
        const stages = (await pool.query('SELECT * FROM sleep_stages WHERE sleep_session_id = $1 ORDER BY sequence, start_time', [sleep.id])).rows;
        sleepSession = { id: sleep.id, startTime: iso(sleep.start_time), endTime: iso(sleep.end_time),
          startOffsetSeconds: number(sleep.start_offset_seconds), endOffsetSeconds: number(sleep.end_offset_seconds),
          stages: stages.map(stage => ({ type: stage.stage_type, startTime: iso(stage.start_time), endTime: iso(stage.end_time) })) };
      }
      const window = sleepSession ? { kind: 'sleep-session', startTime: sleepSession.startTime, endTime: sleepSession.endTime,
        startDate: localDate(sleepSession.startTime, sleepSession.startOffsetSeconds),
        endDateExclusive: shiftOxygenDate(localDate(new Date(Date.parse(sleepSession.endTime) - 1).toISOString(), sleepSession.endOffsetSeconds), 1) }
        : { kind: 'civil-day', ...range };
      const [sampleResult, chunks] = await Promise.all([accountId ? pool.query(
        `SELECT *, ${dateProjection} AS civil_date_text FROM oxygen_saturation_samples WHERE source_account_id = $1
          AND ${sleepSession ? 'sampled_at >= $2 AND sampled_at < $3' : 'civil_date >= $2 AND civil_date < $3'}
          ORDER BY sampled_at, provider_key LIMIT 50001`,
        [accountId, sleepSession ? sqlBoundary(window.startTime, -1) : date, sleepSession ? sqlBoundary(window.endTime, 1) : range.endDateExclusive],
      ) : { rows: [] }, syncRows(accountId, { startDate: window.startDate < date ? window.startDate : date,
        endDateExclusive: window.endDateExclusive > range.endDateExclusive ? window.endDateExclusive : range.endDateExclusive })]);
      if (sampleResult.rows.length > 50000) throw Object.assign(new Error('Too many oxygen readings for a night view; use a full export'), { status: 413 });
      const allSamples = selectOxygenWindow(sampleResult.rows.map(row => ({ ...row, sourceKey: row.source_key,
        sampledAt: row.sample_time_text, percentage: number(row.percentage), utcOffsetSeconds: number(row.utc_offset_seconds),
        exactTime: oxygenInstantNanoseconds(row.sample_time_text) })), sleepSession)
        .sort((a, b) => a.exactTime < b.exactTime ? -1 : a.exactTime > b.exactTime ? 1 : 0);
      const sampleSources = sourceGroups(allSamples), dailySources = sourceGroups(daily);
      const selectedSampleSource = chooseSource(sampleSources, selection.sampleSource);
      const selectedDailySource = chooseSource(dailySources, selection.dailySource);
      const selectedSamples = allSamples.filter(row => row.sourceKey === selectedSampleSource);
      const summary = summarizeOxygenSamples(selectedSamples, sleepSession);
      const plot = buildOxygenSegments(selectedSamples);
      const grouped = new Map();
      for (const sample of selectedSamples) {
        const key = oxygenInstantNanoseconds(sample.sampledAt).toString();
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(sample.percentage);
      }
      const publicSample = row => {
        const values = grouped.get(oxygenInstantNanoseconds(row.sampledAt).toString());
        return { sampledAt: row.sampledAt, utcOffsetSeconds: row.utcOffsetSeconds, percentage: row.percentage,
          conflict: new Set(values).size > 1, duplicate: values.length > new Set(values).size };
      };
      const { dailySummary, dailyCandidates, ambiguous } = dailySelection(daily, selectedDailySource);
      const sync = { intraday: oxygenFetchStatus(chunks.filter(row => row.metric === oxygenMetrics[0]), window),
        daily: oxygenFetchStatus(chunks.filter(row => row.metric === oxygenMetrics[1]), range) };
      return { date, timezone, dataState: dataState(dailySummary, summary.sampleCount,
        (sampleSources.length > 1 && !selectedSampleSource) || (dailySources.length > 1 && !selectedDailySource), sync.intraday.fetchComplete && sync.daily.fetchComplete),
      dailySummary, dailyCandidates, sampleSummary: summary, samples: selectedSamples.map(publicSample),
      plot: { ...plot, segments: plot.segments.map(segment => segment.map(publicSample)) }, sampleSources, dailySources,
      selectedSampleSource, selectedDailySource, sleepSession, window,
      availability: { raw: allSamples.length ? sync.intraday.fetchComplete ? 'local' : 'partial-local' : 'unavailable',
        coldArchiveSupported: false, fetchComplete: sync.intraday.fetchComplete,
        requestedRange: sync.intraday.requestedRange, fetchedRanges: sync.intraday.fetchedRanges }, sync,
      newestSampleAt: allSamples.at(-1)?.sampledAt ?? null,
      qualityFlags: [...summary.qualityFlags, ...(dailySummary?.qualityFlags ?? []), ...(ambiguous ? ['daily-ambiguous'] : []),
        ...(!sleepSession ? ['sleep-session-unavailable'] : [])] };
    },

    async getRange(accountId, range, selection = {}) {
      validateOxygenRange(range.startDate, range.endDateExclusive, 'day', selection);
      const [timezone, rows, chunks] = await Promise.all([accountTimezone(accountId), dailyRows(accountId, range), syncRows(accountId, range)]);
      const dailySources = sourceGroups(rows), selectedDailySource = chooseSource(dailySources, selection.dailySource);
      const dailyChunks = chunks.filter(row => row.metric === oxygenMetrics[1]);
      const days = [];
      for (let date = range.startDate; date < range.endDateExclusive; date = shiftOxygenDate(date, 1)) {
        const { dailySummary, dailyCandidates, ambiguous } = dailySelection(rows.filter(row => dateOnly(row.civil_date_text ?? row.civil_date) === date), selectedDailySource);
        days.push({ date, dailySummary, dailyCandidates, dataState: dataState(dailySummary, 0, dailySources.length > 1 && !selectedDailySource,
          oxygenFetchStatus(dailyChunks, { startDate: date, endDateExclusive: shiftOxygenDate(date, 1) }).fetchComplete), qualityFlags: ambiguous ? ['daily-ambiguous'] : [] });
      }
      const values = days.filter(day => day.dailySummary).map(day => day.dailySummary.averagePercentage);
      return { ...range, timezone, days, dailySources, selectedDailySource,
        periodSummary: { averageDailyPercentage: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
          daysWithSummary: values.length, requestedDays: days.length, missingDays: days.length - values.length },
        sync: { daily: oxygenFetchStatus(dailyChunks, range) } };
    },
  };
  return repository;
}
