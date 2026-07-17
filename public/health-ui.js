const STAGES = ['awake', 'light', 'deep', 'rem'];

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundOne(value) {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function shiftMonth(monthStart, months) {
  const value = new Date(`${monthStart}T12:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}

function monthStart(date) {
  return `${date.slice(0, 7)}-01`;
}

function datesInRange(startDate, endDateExclusive) {
  const dates = [];
  for (let date = startDate; date < endDateExclusive; date = shiftDate(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function averageDuration(values) {
  const recorded = values.filter((value) => Number.isFinite(value));
  return {
    durationMinutes: recorded.length
      ? Math.round(recorded.reduce((sum, value) => sum + value, 0) / recorded.length)
      : null,
    recordedNights: recorded.length,
  };
}

function trendSessionMap(sessions) {
  const byDate = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const durationMinutes = finite(session?.durationMinutes);
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(String(session?.date || '')) &&
      durationMinutes !== null &&
      durationMinutes >= 0 &&
      !byDate.has(session.date)
    ) {
      byDate.set(session.date, durationMinutes);
    }
  }
  return byDate;
}

function trendRow(byDate, { key, label, startDate, endDateExclusive }) {
  return {
    key,
    label,
    startDate,
    endDateExclusive,
    ...averageDuration(
      datesInRange(startDate, endDateExclusive).map((date) => byDate.get(date) ?? null),
    ),
  };
}

export function civilDateInTimeZone(value = new Date(), timeZone = 'America/Toronto') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatDuration(minutes) {
  const value = finite(minutes);
  if (value === null || value < 0) return '—';
  const rounded = Math.round(value);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (!hours) return `${remainder}m`;
  if (!remainder) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

export function sleepStageBreakdown(stageSummary = {}, durationMinutes = 0) {
  const denominator = Math.max(0, finite(durationMinutes) ?? 0);
  return STAGES.map((type) => {
    const minutes = Math.max(0, finite(stageSummary[type]?.minutes) ?? 0);
    return {
      type,
      minutes,
      duration: formatDuration(minutes),
      percentage: denominator ? roundOne((minutes / denominator) * 100) : 0,
    };
  });
}

export function buildSleepLanes(stages = [], startTime, endTime) {
  const start = Date.parse(startTime);
  const end = Date.parse(endTime);
  const duration = end - start;
  const lanes = Object.fromEntries(STAGES.map((stage) => [stage, []]));
  if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0) return lanes;

  for (const stage of Array.isArray(stages) ? stages : []) {
    if (!lanes[stage.type]) continue;
    const stageStart = Math.max(start, Date.parse(stage.startTime));
    const stageEnd = Math.min(end, Date.parse(stage.endTime));
    if (!Number.isFinite(stageStart) || !Number.isFinite(stageEnd) || stageEnd <= stageStart) continue;
    lanes[stage.type].push({
      ...stage,
      leftPercent: roundOne(((stageStart - start) / duration) * 100),
      widthPercent: roundOne(((stageEnd - stageStart) / duration) * 100),
    });
  }
  return lanes;
}

export function dateRangeForPreset(preset, selectedDate) {
  const days = { day: 1, week: 7, month: 30, year: 365 }[preset] ?? 7;
  return {
    startDate: shiftDate(selectedDate, -(days - 1)),
    endDateExclusive: shiftDate(selectedDate, 1),
  };
}

export function sleepTrendRange(period, selectedDate) {
  if (period === '1-month') {
    return {
      startDate: shiftDate(selectedDate, -27),
      endDateExclusive: shiftDate(selectedDate, 1),
    };
  }
  if (period === '1-year') {
    const selectedMonth = monthStart(selectedDate);
    return {
      startDate: shiftMonth(selectedMonth, -11),
      endDateExclusive: shiftMonth(selectedMonth, 1),
    };
  }
  return {
    startDate: shiftDate(selectedDate, -6),
    endDateExclusive: shiftDate(selectedDate, 1),
  };
}

export function buildSleepTrendRows(sessions, period, selectedDate) {
  const byDate = trendSessionMap(sessions);
  const range = sleepTrendRange(period, selectedDate);

  if (period === '1-month') {
    return Array.from({ length: 4 }, (_, index) => {
      const startDate = shiftDate(range.startDate, index * 7);
      return trendRow(byDate, {
        key: startDate,
        label: `Week ${index + 1}`,
        startDate,
        endDateExclusive: shiftDate(startDate, 7),
      });
    });
  }

  if (period === '1-year') {
    return Array.from({ length: 12 }, (_, index) => {
      const startDate = shiftMonth(range.startDate, index);
      return trendRow(byDate, {
        key: startDate.slice(0, 7),
        label: new Intl.DateTimeFormat('en-US', {
          month: 'short',
          timeZone: 'UTC',
        }).format(new Date(`${startDate}T12:00:00Z`)),
        startDate,
        endDateExclusive: shiftMonth(startDate, 1),
      });
    });
  }

  return datesInRange(range.startDate, range.endDateExclusive).map((date) =>
    trendRow(byDate, {
      key: date,
      label: new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: 'UTC',
      }).format(new Date(`${date}T12:00:00Z`)),
      startDate: date,
      endDateExclusive: shiftDate(date, 1),
    }),
  );
}

export function scaleSleepTrendRows(rows, targetMinutes = 420) {
  const observedMaximum = Math.max(
    0,
    ...rows.map(({ durationMinutes }) => finite(durationMinutes) ?? 0),
  );
  const maximumMinutes = Math.max(540, Math.ceil(observedMaximum / 60) * 60);
  return {
    maximumMinutes,
    targetMinutes,
    targetPercent: roundOne((targetMinutes / maximumMinutes) * 100),
    rows: rows.map((row) => {
      const durationMinutes = finite(row.durationMinutes);
      return {
        ...row,
        fillPercent:
          durationMinutes === null
            ? 0
            : roundOne(Math.min(100, (durationMinutes / maximumMinutes) * 100)),
        targetState:
          durationMinutes === null
            ? 'missing'
            : durationMinutes >= targetMinutes
              ? 'reached'
              : 'below',
      };
    }),
  };
}

export function exportPollingNeeded(jobs = []) {
  return jobs.some(({ status }) => status === 'queued' || status === 'running');
}

export function isLocalDevelopmentHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
    String(hostname || '').toLowerCase(),
  );
}
