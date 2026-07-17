import sharp from 'sharp';

const STAGE_COLORS = {
  awake: '#f59ab7',
  light: '#8fb7ff',
  deep: '#7967e8',
  rem: '#c56dde',
};

function xml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function average(values) {
  const present = values.filter((value) => Number.isFinite(value));
  if (!present.length) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function duration(minutes) {
  if (!Number.isFinite(minutes)) return 'No data';
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return hours ? `${hours}h ${remainder}m` : `${remainder}m`;
}

function number(value, suffix = '') {
  return Number.isFinite(value) ? `${Math.round(value)}${suffix}` : 'No data';
}

function endInclusive(endDateExclusive) {
  const date = new Date(`${endDateExclusive}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function stageTotals(stages) {
  const totals = { awake: 0, light: 0, deep: 0, rem: 0 };
  for (const stage of stages) {
    if (stage.stageType in totals) totals[stage.stageType] += Number(stage.durationSeconds) || 0;
  }
  return totals;
}

function stageBar(totals) {
  const width = 1440;
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (!total) {
    return '<rect x="80" y="466" width="1440" height="34" rx="17" fill="#252b36"/>';
  }
  let x = 80;
  return Object.entries(totals)
    .map(([stage, seconds]) => {
      const segment = (seconds / total) * width;
      const markup = `<rect x="${x.toFixed(2)}" y="466" width="${Math.max(segment, 1).toFixed(2)}" height="34" fill="${STAGE_COLORS[stage]}"/>`;
      x += segment;
      return markup;
    })
    .join('');
}

function stageLegend(totals) {
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return Object.entries(totals)
    .map(([stage, seconds], index) => {
      const x = 80 + index * 360;
      const percentage = total ? (seconds / total) * 100 : 0;
      return `
        <circle cx="${x + 8}" cy="545" r="7" fill="${STAGE_COLORS[stage]}"/>
        <text x="${x + 26}" y="550" class="stage-name">${xml(stage)}</text>
        <text x="${x}" y="582" class="stage-value">${duration(seconds / 60)} · ${percentage.toFixed(1)}%</text>
      `;
    })
    .join('');
}

function dailyRows(days) {
  const visible = days.slice(-6);
  if (!visible.length) {
    return '<text x="80" y="690" class="muted">No normalized daily summaries in this range.</text>';
  }
  return visible
    .map((day, index) => {
      const y = 700 + index * 45;
      return `
        <text x="80" y="${y}" class="date">${xml(day.date)}</text>
        <text x="360" y="${y}" class="row-value">${xml(duration(day.sleepDurationMinutes))}</text>
        <text x="760" y="${y}" class="row-value">${xml(number(day.heartRestingBpm, ' bpm'))}</text>
        <text x="1160" y="${y}" class="row-value">${xml(number(day.calorieTotalKcal, ' kcal'))}</text>
      `;
    })
    .join('');
}

export function buildSummarySvg(dataset) {
  const days = dataset.dailySummaries;
  const stageSummary = stageTotals(dataset.sleepStages);
  const sleepAverage = average(days.map(({ sleepDurationMinutes }) => sleepDurationMinutes));
  const restingAverage = average(days.map(({ heartRestingBpm }) => heartRestingBpm));
  const calorieAverage = average(days.map(({ calorieTotalKcal }) => calorieTotalKcal));
  const rangeLabel =
    dataset.range.endDateExclusive === nextDay(dataset.range.startDate)
      ? dataset.range.startDate
      : `${dataset.range.startDate} to ${endInclusive(dataset.range.endDateExclusive)}`;

  return `
    <svg width="1600" height="1000" viewBox="0 0 1600 1000" xmlns="http://www.w3.org/2000/svg">
      <style>
        text { font-family: Inter, "Segoe UI", Arial, sans-serif; fill: #f4f6fb; }
        .eyebrow { font-size: 22px; fill: #8f9bad; letter-spacing: 2px; text-transform: uppercase; }
        .title { font-size: 54px; font-weight: 700; }
        .subtitle { font-size: 22px; fill: #aab3c2; }
        .metric-label { font-size: 20px; fill: #9aa6b8; }
        .metric-value { font-size: 48px; font-weight: 700; }
        .metric-note { font-size: 18px; fill: #7f8b9e; }
        .section { font-size: 26px; font-weight: 650; }
        .stage-name { font-size: 18px; fill: #aab3c2; text-transform: capitalize; }
        .stage-value { font-size: 21px; font-weight: 600; }
        .column { font-size: 16px; fill: #7f8b9e; letter-spacing: 1px; }
        .date { font-size: 20px; fill: #aab3c2; }
        .row-value { font-size: 21px; font-weight: 600; }
        .muted { font-size: 20px; fill: #7f8b9e; }
      </style>
      <rect width="1600" height="1000" fill="#0d1118"/>
      <rect x="0" y="0" width="1600" height="8" fill="#79d69a"/>
      <text x="80" y="76" class="eyebrow">Personal health data hub</text>
      <text x="80" y="143" class="title">Health summary</text>
      <text x="80" y="184" class="subtitle">${xml(rangeLabel)} · ${xml(dataset.timezone)}</text>

      <line x1="80" y1="232" x2="1520" y2="232" stroke="#252b36"/>
      <text x="80" y="282" class="metric-label">Average sleep</text>
      <text x="80" y="344" class="metric-value">${xml(duration(sleepAverage))}</text>
      <text x="80" y="380" class="metric-note">${days.filter(({ sleepDurationMinutes }) => Number.isFinite(sleepDurationMinutes)).length} days measured</text>

      <text x="585" y="282" class="metric-label">Average resting heart rate</text>
      <text x="585" y="344" class="metric-value">${xml(number(restingAverage, ' bpm'))}</text>
      <text x="585" y="380" class="metric-note">No smoothed or inferred chart values</text>

      <text x="1090" y="282" class="metric-label">Average total expenditure</text>
      <text x="1090" y="344" class="metric-value">${xml(number(calorieAverage, ' kcal'))}</text>
      <text x="1090" y="380" class="metric-note">Active and basal energy, never food intake</text>

      <text x="80" y="442" class="section">Sleep-stage composition</text>
      <clipPath id="stage-clip"><rect x="80" y="466" width="1440" height="34" rx="17"/></clipPath>
      <g clip-path="url(#stage-clip)">${stageBar(stageSummary)}</g>
      ${stageLegend(stageSummary)}

      <line x1="80" y1="616" x2="1520" y2="616" stroke="#252b36"/>
      <text x="80" y="650" class="column">DATE</text>
      <text x="360" y="650" class="column">SLEEP</text>
      <text x="760" y="650" class="column">RESTING HEART</text>
      <text x="1160" y="650" class="column">TOTAL CALORIES</text>
      ${dailyRows(days)}

      <text x="80" y="972" class="muted">Generated from exact archived values · schema ${xml(dataset.schemaVersion)} · ${dataset.coverageWarnings.length} coverage warnings</text>
    </svg>
  `;
}

function nextDay(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

export async function renderSummaryPng(dataset) {
  return sharp(Buffer.from(buildSummarySvg(dataset)))
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
}
