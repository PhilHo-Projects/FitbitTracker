import { createSleepPatterns } from './sleep-insights-ui.js';

const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const shift = (date, days) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
const rested = [
  "Very tired",
  "Somewhat tired",
  "Okay",
  "Rested",
  "Very rested",
];
const contexts = [
  "illness",
  "stress",
  "late meal",
  "caffeine",
  "alcohol",
  "travel",
  "heat",
  "noise",
];
const stageColors = {
  awake: "var(--awake)",
  wake: "var(--awake)",
  light: "var(--light)",
  deep: "var(--deep)",
  rem: "var(--rem)",
  asleep: "var(--light)",
};
export function sleepDuration(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  const minutes = Math.round(value);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
export function measurementLabel(metric, value = metric?.value) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (metric.unit === "min") return sleepDuration(value);
  if (metric.unit === "clock") {
    const minutes = ((Math.round(value) % 1440) + 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  return `${Number(value.toFixed(["ms", "°C", "%", "breaths/min"].includes(metric.unit) ? 1 : 0))} ${metric.unit ?? ""}`;
}
function dateLabel(date) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
export function recordedTime(instant, offset, timezone) {
  if (Number.isFinite(offset)) {
    const d = new Date(Date.parse(instant) + offset * 1000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  return new Date(instant).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: timezone ?? "UTC",
  });
}
function baselineText(m) {
  if (m.comparisonContext === 'nap') return 'Nap measurements are shown separately. Whole-night goals and main-sleep baselines do not apply.';
  const b = m.baseline;
  if (!Number.isFinite(m.value)) return "No measurement available.";
  if (!m.eligible)
    return "Excluded from comparisons: processing, source ambiguity, or incomplete observations.";
  if (!b || b.count < 14)
    return `Building your baseline — ${b?.count ?? 0} of 14 nights.`;
  const range = `Recent range ${measurementLabel(m, b.p10)}–${measurementLabel(m, b.p90)}; median ${measurementLabel(m, b.median)}. ${b.count} nights.`;
  if (b.comparison === "flat")
    return `${range} ${Math.abs(b.delta).toFixed(1)} ${m.unit === "clock" ? "minutes" : m.unit} ${b.delta < 0 ? "below" : "above"} the median; the range has no spread.`;
  return `${b.comparison[0].toUpperCase() + b.comparison.slice(1)} your recent range. ${range}`;
}
function evidence(m, key) {
  const goal =
    key === "duration" && Number.isFinite(m.goalDifferenceMinutes)
      ? `<p>${sleepDuration(Math.abs(m.goalDifferenceMinutes))} ${m.goalDifferenceMinutes < 0 ? "below" : "above"} your chosen ${sleepDuration(m.goalMinutes)} goal.</p>`
      : "";
  return `<details class="sleep-evidence" id="sleep-evidence-${key}"><summary><span>${escape(m.label)}</span><strong>${measurementLabel(m)}</strong></summary>${goal}<p>${escape(baselineText(m))}</p>${m.providerDate ? `<p>Provider date: ${m.providerDate}. A daily summary, independent of the selected session.</p>` : ""}${m.coverageFraction != null ? `<p>${Math.round(m.coverageFraction * 100)}% of identified asleep minute bins contain readings (${m.usableMinuteBins}/${m.asleepMinuteBins}). ${escape(m.completenessRule)}</p>` : ""}<p class="sleep-meta">${escape(m.method ?? "No calculation available")} · ${escape(m.sourceKey?.slice(0, 10) ?? "No source")}${m.baseline ? ` · ${m.baseline.start} to ${m.baseline.endExclusive} (end excluded)` : ""}</p></details>`;
}
export function renderSleepAssessment(assessment) {
  if (!assessment) return "";
  return `<p class="sleep-assessment-title">${escape(assessment.headline)}.</p><div class="sleep-findings">${assessment.headlineFindings.map((f) => `<a href="#sleep-evidence-${f.key}" data-evidence="${f.key}">${escape(f.text)} ↗</a>`).join("")}</div>${assessment.notes.length ? `<p class="sleep-data-note">${escape(assessment.notes.join(" "))}</p>` : ""}`;
}
function sourceSelect(key, measurement) {
  if (
    !measurement?.sources?.length ||
    (measurement.sources.length === 1 &&
      measurement.state !== "source-unavailable")
  )
    return "";
  return `<label class="sleep-source-label">${escape(key)} source<select data-sleep-source="${key}"><option value="">Choose a source</option>${measurement.sources.map((s) => `<option value="${escape(s.key)}" ${measurement.sourceKey === s.key ? "selected" : ""}>${escape(s.label)} · ${s.key.slice(0, 8)}</option>`).join("")}</select></label>`;
}
function timelineMarkup(report) {
  const tracks = report.tracks,
    start = Date.parse(tracks.startTime),
    end = Date.parse(tracks.endTime),
    span = end - start;
  const x = (time) =>
    Math.max(0, Math.min(1000, ((Date.parse(time) - start) / span) * 1000));
  const ys = { awake: 6, wake: 6, rem: 22, light: 38, asleep: 38, deep: 54 };
  const stageRects = tracks.stages
    .map(
      (s) =>
        `<rect x="${x(s.startTime)}" y="${ys[s.type] ?? 38}" width="${Math.max(0.5, x(s.endTime) - x(s.startTime))}" height="13" fill="${stageColors[s.type] ?? "var(--muted)"}"/>`,
    )
    .join("");
  const outOfBed = tracks.outOfBed
    .map(
      (s) =>
        `<rect x="${x(s.startTime)}" y="73" width="${Math.max(1, x(s.endTime) - x(s.startTime))}" height="5" fill="var(--text)"/>`,
    )
    .join("");
  const specifications = [
    ["heart", 95, 155, "bpm"],
    ["spo2", 182, 237, "%"],
    ["hrv", 265, 320, "ms"],
  ];
  const signalTracks = specifications
    .map(([key, top, bottom]) => {
      const samples = tracks[key].samples,
        values = samples
          .filter((s) => !s.conflict && Number.isFinite(s.value))
          .map((s) => s.value);
      if (!values.length)
        return `<text x="500" y="${(top + bottom) / 2}" text-anchor="middle" class="sleep-svg-empty">${tracks[key].state === "selection-required" ? "Choose a source to display readings" : "No readings available"}</text>`;
      const min = Math.min(...values) - 1,
        max = Math.max(...values) + 1;
      // Keep extrema for dense tracks; every original observation remains available to the cursor and reading table.
      const groups = new Map();
      for (const s of samples) {
        if (!Number.isFinite(s.value)) continue;
        const bin = Math.floor(x(s.sampledAt));
        const group = groups.get(bin) ?? [];
        group.push(s);
        groups.set(bin, group);
      }
      const visible = [...groups.values()].flatMap((group) =>
        group.length < 4
          ? group
          : [
              group[0],
              group.reduce((a, b) => (a.value < b.value ? a : b)),
              group.reduce((a, b) => (a.value > b.value ? a : b)),
              group.at(-1),
            ],
      );
      return visible
        .map(
          (s) =>
            `<circle cx="${x(s.sampledAt)}" cy="${bottom - ((s.value - min) / (max - min)) * (bottom - top)}" r="${s.conflict ? 2.5 : 1.8}" fill="${s.conflict ? "var(--awake)" : key === "heart" ? "var(--accent)" : key === "spo2" ? "var(--rem)" : "var(--deep)"}"/>`,
        )
        .join("");
    })
    .join("");
  return `<section class="sleep-card sleep-timeline"><div class="sleep-section-heading"><div><p class="view-kicker">Your night, together</p><h2>Overnight timeline</h2></div><span class="sleep-meta">${recordedTime(tracks.startTime, report.session.startOffsetSeconds, report.timezone)}–${recordedTime(tracks.endTime, report.session.endOffsetSeconds, report.timezone)}</span></div>
    <div class="sleep-legend">${["awake", "rem", "light", "deep"].map((s) => `<span><i style="background:${stageColors[s]}"></i>${s === "rem" ? "REM" : s[0].toUpperCase() + s.slice(1)}</span>`).join("")}<span><i style="background:var(--text)"></i>Out of bed</span></div>
    <div class="sleep-track-layout"><div class="sleep-track-labels"><span>Stages</span><span>Heart rate<small>bpm</small></span><span>SpO₂<small>%</small></span><span>HRV<small>ms</small></span></div><div class="sleep-track-plot"><svg data-sleep-timeline viewBox="0 0 1000 330" preserveAspectRatio="none" role="img" aria-label="Aligned overnight observations. Use the inspection slider for exact measurements."><g stroke="var(--border)">${[85, 169, 250, 329].map((y) => `<line x1="0" y1="${y}" x2="1000" y2="${y}"/>`).join("")}</g>${stageRects}${outOfBed}${signalTracks}<line data-sleep-cursor x1="0" x2="0" y1="0" y2="330" stroke="var(--text)" stroke-width="1.5"/></svg><div class="sleep-time-axis">${[0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${recordedTime(new Date(start + span * f).toISOString(), f === 0 ? report.session.startOffsetSeconds : f === 1 ? report.session.endOffsetSeconds : report.session.startOffsetSeconds === report.session.endOffsetSeconds ? report.session.startOffsetSeconds : null, report.timezone)}</span>`).join("")}</div>
    <label class="sr-only" for="sleepInspector">Inspect overnight measurements</label><input id="sleepInspector" data-sleep-inspector type="range" min="0" max="${Math.ceil(span / 1000)}" step="30" value="0" aria-describedby="sleepInspectHelp"/></div></div>
    <p class="sleep-meta" id="sleepInspectHelp">Touch or move across the chart, or use the slider’s arrow keys. Dots are observations; gaps stay empty. Times use recorded offsets where available.</p><div data-sleep-readout class="sleep-cursor-readout" aria-live="polite"></div>
    <details class="sleep-diagnostics"><summary>Sources &amp; reading details</summary>${specifications.map(([key]) => sourceSelect(`${key}Track`, tracks[key])).join("")}<p>Summary cards are provider-date values. They are never drawn as overnight traces. Dense tracks retain extrema for display; inspection uses the original readings.</p>${specifications
      .map(
        ([key]) =>
          `<details><summary>${key === "spo2" ? "SpO₂" : key === "hrv" ? "HRV" : "Heart rate"} · ${tracks[key].observationCount} readings · ${tracks[key].conflictCount} conflicts${tracks[key].truncated ? " · display limited to 50,000 readings" : ""}</summary><div class="sleep-table-scroll"><table><thead><tr><th>Original timestamp</th><th>Value</th><th>Status</th></tr></thead><tbody>${tracks[
            key
          ].samples
            .slice(0, 200)
            .map(
              (s) =>
                `<tr><td>${escape(s.sampledAt)}</td><td>${Number.isFinite(s.value) ? Number(s.value.toFixed(2)) : 'Unavailable'}</td><td>${s.conflict ? "Conflicting readings" : "Recorded"}</td></tr>`,
            )
            .join(
              "",
            )}</tbody></table></div><p>First 200 readings shown. Full records are available in exports.</p></details>`,
      )
      .join("")}</details></section>`;
}
function checkInMarkup(date, entry) {
  return `<form data-sleep-check-in><p class="sleep-meta">Optional · morning of ${escape(date)}. Leave any answer blank.</p><fieldset><legend>How rested do you feel?</legend><div class="sleep-rating-options">${rested.map((text, i) => `<label><input type="radio" name="restfulness" value="${i + 1}" ${entry?.restfulness === i + 1 ? "checked" : ""}/><span>${text}</span></label>`).join("")}</div></fieldset><fieldset><legend>How many awakenings do you remember?</legend><div class="sleep-choice-options">${[0, 1, 2, 3].map((n) => `<label><input type="radio" name="awakenings" value="${n}" ${entry?.awakenings === n ? "checked" : ""}/><span>${n === 3 ? "3+" : n}</span></label>`).join("")}</div></fieldset><fieldset><legend>Anything unusual?</legend><div class="sleep-choice-options">${contexts.map((c) => `<label><input type="checkbox" name="context" value="${c}" ${entry?.context?.includes(c) ? "checked" : ""}/><span>${c}</span></label>`).join("")}<label><input type="checkbox" name="contextNone" ${entry?.contextReviewed && !entry?.context?.length ? "checked" : ""}/><span>None of these factors</span></label></div></fieldset><label class="sleep-note-label">Optional note<textarea name="note" rows="2" maxlength="2000" placeholder="A little context for this night">${escape(entry?.note ?? "")}</textarea></label><div class="sleep-form-actions"><button class="button button-primary" type="submit">${entry ? "Update" : "Save"} check-in</button><button class="button button-secondary" type="button" data-sleep-skip>Skip</button><button class="button button-secondary" type="reset">Clear answers</button>${entry ? '<button class="button button-secondary" type="button" data-sleep-delete>Delete</button>' : ""}</div><p class="sleep-meta">Encrypted with your journal key. Context is recorded without inferring its effects.</p></form>`;
}
export function renderSleepReport(report) {
  const { date, session, assessment: a } = report;
  const recorded = report.dates ?? [];
  const previous = recorded.find(d => d < date), next = [...recorded].reverse().find(d => d > date);
  const header = `<div class="sleep-heading"><div><p class="view-kicker" data-sleep-kicker>Your night, in focus</p><h1 data-sleep-page-title>${date ? dateLabel(date) : 'Your sleep'}</h1><p data-sleep-heading-copy>Time asleep. What changed. What the data supports.</p></div><div class="sleep-date-controls"><button class="button button-secondary" data-sleep-browse data-sleep-date="${previous ?? ''}" ${previous ? '' : 'disabled'}>‹ Previous night</button><label><span>Wake date</span><input type="date" data-sleep-calendar value="${date ?? ''}" ${recorded[0] ? `max="${recorded[0]}"` : ''}/></label><button class="button button-secondary" data-sleep-browse data-sleep-date="${next ?? ''}" ${next ? '' : 'disabled'}>Next night ›</button><button class="button button-secondary" data-sleep-latest ${!recorded.length || date === recorded[0] ? 'disabled' : ''}>Latest recorded night</button></div></div>`;
  const awaitingRecords = date ? '' : '<h2>No sleep history yet</h2><p class="sleep-meta">Connect and sync your account in Data &amp; settings, or choose a wake date to explore its history.</p>';
  const analysis = `<div data-sleep-panel="trends" hidden><section data-sleep-trends class="sleep-card">${awaitingRecords}</section><section data-period-comparisons class="sleep-card lens-periods" ${date ? '' : 'hidden'}></section></div><section data-sleep-panel="patterns" hidden><div data-sleep-patterns>${awaitingRecords}</div></section>`;
  if (!session) return `${header}<section data-sleep-panel="sleep" class="sleep-card lens-empty"><h2>No sleep recorded${date ? ' on this date' : ''}</h2><p>Missing records are not zero sleep. Your history and saved check-ins remain available.</p></section>${analysis}`;
  const primary = report.mainSessionId === session.id ? 'Main sleep' : session.isNap ? 'Nap' : 'Additional sleep';
  const stat = (label, value, note) => `<div><dt>${label}</dt><dd>${value}</dd><small>${note}</small></div>`;
  const stage = key => session.stageSummary?.[key]?.minutes;
  const stageNote = key => Number.isFinite(stage(key)) && session.minutesAsleep > 0 ? `${Math.round(stage(key) / session.minutesAsleep * 100)}% of time asleep` : 'Stage duration unavailable';
  const signals = Object.entries(report.physiology).map(([key,m]) => sourceSelect(key,m)).join('');
  return `${header}<div data-sleep-panel="sleep"><div class="sleep-session-row"><label>Session<select data-sleep-session>${report.sessions.map(s => `<option value="${s.id}" ${s.id === session.id ? 'selected' : ''}>${s.id === report.mainSessionId ? 'Main sleep' : s.isNap ? 'Nap' : 'Additional sleep'} · ${sleepDuration(s.minutesAsleep)} · ${recordedTime(s.startTime,s.startOffsetSeconds,report.timezone)}–${recordedTime(s.endTime,s.endOffsetSeconds,report.timezone)}</option>`).join('')}</select></label><span class="sleep-meta">${a.provisional ? 'Provisional · ' : ''}Recorded local time · ${primary}</span></div>
  <section class="lens-night-summary" aria-label="Night summary"><div class="lens-night-assessment">${renderSleepAssessment(a)}</div><dl>${stat('Time asleep',sleepDuration(session.minutesAsleep),`${sleepDuration(session.durationMinutes)} recorded`)}${stat('Sleep efficiency',measurementLabel(a.metrics.efficiency),'Asleep ÷ recorded period')}${stat('Deep sleep',sleepDuration(stage('deep')),stageNote('deep'))}${stat('REM sleep',sleepDuration(stage('rem')),stageNote('rem'))}</dl></section>
  ${timelineMarkup(report)}
  <section class="lens-measurements"><div class="sleep-section-heading"><h2>A little more context</h2><p class="sleep-meta">Daily summaries for ${date}; separate from the overnight readings.</p></div><dl>${['hrv','breathing','temperature','spo2'].map(key => stat(a.metrics[key].label,measurementLabel(a.metrics[key]),'Provider-date summary')).join('')}${stat('Time to fall asleep',sleepDuration(session.timeToSleepMinutes),'Selected session')}</dl></section>
  <details class="lens-checkin" data-sleep-checkin-disclosure><summary data-checkin-label><span><strong>How did it feel?</strong><small>Add restfulness and anything unusual to put the numbers in context.</small></span><span class="lens-checkin-action">Add check-in</span></summary><div data-sleep-check-in-container>${report.checkInDate ? 'Loading your optional check-in…' : 'Available when a main sleep is recorded for this wake date.'}</div></details>
  <div class="lens-night-tools"><details class="sleep-goal"><summary>Sleep goal · ${sleepDuration(report.preferences.goalMinutes)}</summary><form data-sleep-goal><label>Chosen goal in minutes<input name="goalMinutes" type="number" min="60" max="1440" step="1" value="${report.preferences.goalMinutes}" required/></label><button class="button button-secondary" type="submit">Update goal</button></form><p>Your chosen goal is separate from your recent baseline. Naps do not count towards the main-sleep goal.</p></details><details class="sleep-data-status"><summary>${a.notes.length ? 'Some data unavailable' : 'Sources & data details'}</summary><p>Newest measurement: ${escape(report.newestMeasurementAt)}. Sleep processing: ${session.processed === true ? 'complete' : session.processed === false ? 'pending' : 'not provided'}. Stages: ${escape(session.metadata.stagesStatus ?? 'status not provided')}.</p>${signals}${Object.entries(report.availability).map(([key,v]) => `<p><strong>${escape(key)}</strong>: ${v.permissionDenied ? 'permission denied' : escape(v.lastAttemptStatus)} · ${escape(v.observationState ?? 'not loaded')}${v.fetchComplete ? ' · completed fetch' : ''}<br/>Last successful fetch: ${escape(v.lastSuccessfulFetchAt ?? 'not recorded')}. ${escape(v.reliability)}</p>`).join('')}<p>Missing measurements do not establish normal physiology or device support. Complete provider records remain in exports.</p>${report.respiratorySummaries.map(v => `<p>${v.providerDate} · ${escape(v.sampledAt)} · ${v.breathsPerMinute ?? 'Unavailable'} breaths/min</p>`).join('')}</details></div>
  <details class="lens-evidence"><summary>What supports this assessment?</summary><p class="sleep-meta">Recent range = the previous 28 calendar days, excluding this night. At least 14 usable nights per measurement. Historical comparisons, not clinical reference intervals.</p><p class="sleep-meta">${sleepDuration(session.minutesAwake)} awake · ${sleepDuration(report.totalSleep.minutesAsleep)} total including naps.${report.totalSleep.reason ? ` Combined total unavailable: ${escape(report.totalSleep.reason)}.` : ''}</p><div class="sleep-indicators">${a.indicators.map(i => `<a href="#sleep-indicator-${i.key}" data-indicator="${i.key}"><span>${i.label}</span><strong>${i.metrics.every(k=>a.metrics[k].assessable) ? 'View comparison' : 'Partial data'}</strong></a>`).join('')}</div>${a.indicators.map(i => `<div id="sleep-indicator-${i.key}" class="sleep-indicator-detail"><h3>${i.label}</h3>${i.metrics.map(key=>evidence(a.metrics[key],key)).join('')}</div>`).join('')}</details></div>${analysis}`;
}
export function cursorReading(report, milliseconds) {
  const t = report.tracks,
    stage = t.stages.filter(
      (s) =>
        Date.parse(s.startTime) <= milliseconds &&
        Date.parse(s.endTime) > milliseconds,
    );
  const stageLabel =
    stage.length === 1
      ? stage[0].type
      : stage.length > 1
        ? "Conflicting stages"
        : "Stage unavailable";
  const result = { stage: stageLabel, measurements: {} };
  for (const key of ["heart", "spo2", "hrv"]) {
    const samples = t[key].samples;
    let nearest = null;
    for (const sample of samples.filter(s=>Number.isFinite(s.value)))
      if (
        !nearest ||
        Math.abs(Date.parse(sample.sampledAt) - milliseconds) <
          Math.abs(Date.parse(nearest.sampledAt) - milliseconds)
      )
        nearest = sample;
    result.measurements[key] =
      nearest && Math.abs(Date.parse(nearest.sampledAt) - milliseconds) <= 60000
        ? nearest
        : null;
  }
  return result;
}
function bindTimeline(root, report) {
  const svg = root.querySelector("[data-sleep-timeline]"),
    slider = root.querySelector("[data-sleep-inspector]");
  if (!svg) return;
  const start = Date.parse(report.tracks.startTime),
    end = Date.parse(report.tracks.endTime);
  function inspect(seconds) {
    const time = Math.min(end - 1, start + seconds * 1000),
      read = cursorReading(report, time),
      x = ((time - start) / (end - start)) * 1000;
    const line = root.querySelector("[data-sleep-cursor]");
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    slider.value = seconds;
    const timeText = recordedTime(
      new Date(time).toISOString(),
      report.session.startOffsetSeconds === report.session.endOffsetSeconds
        ? report.session.startOffsetSeconds
        : null,
      report.timezone,
    );
    const labels = {
      heart: ["Heart rate", "bpm"],
      spo2: ["SpO₂", "%"],
      hrv: ["HRV", "ms"],
    };
    root.querySelector("[data-sleep-readout]").innerHTML =
      `<div><span>Cursor · ${timeText}</span><strong>${escape(read.stage)}</strong><small>${new Date(time).toISOString()}</small></div>${Object.entries(
        read.measurements,
      )
        .map(
          ([key, s]) =>
            `<div><span>${labels[key][0]}</span><strong>${s ? (s.conflict ? "Conflicting readings" : `${Number(s.value.toFixed(1))} ${labels[key][1]}`) : "No nearby reading"}</strong><small>${s ? `Observed ${recordedTime(s.sampledAt, s.utcOffsetSeconds, report.timezone)} · ${Math.round(Math.abs(Date.parse(s.sampledAt) - time) / 1000)}s from cursor` : "No observation within 60s"}</small></div>`,
        )
        .join("")}`;
    slider.setAttribute(
      "aria-valuetext",
      `${timeText}, ${read.stage}, ${Object.entries(read.measurements)
        .map(
          ([key, s]) =>
            `${labels[key][0]} ${s ? (s.conflict ? "conflicting" : `${s.value} ${labels[key][1]} observed at ${s.sampledAt}`) : "unavailable"}`,
        )
        .join(", ")}`,
    );
  }
  const pointer = (e) => {
    const rect = svg.getBoundingClientRect();
    inspect(
      (Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) *
        (end - start)) /
        1000,
    );
  };
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    pointer(e);
  });
  svg.addEventListener("pointermove", pointer);
  slider.addEventListener("input", () => inspect(Number(slider.value)));
  inspect(0);
}
function trendsMarkup(data, period, key, ratings = []) {
  const isYear = period === "year",
    daily = data.days ?? [],
    monthly = data.months ?? [],
    metrics = [
      ["duration", "Actual sleep"],
      ["bedtime", "Bedtime"],
      ["wakeTime", "Wake time"],
      ["awake", "Recorded awake"],
      ["efficiency", "Efficiency"],
      ["sleepingHr", "Sleeping HR"],
      ["hrv", "Daily HRV"],
      ["breathing", "Breathing rate"],
      ["temperature", "Skin temperature"],
      ["spo2", "Daily SpO₂"],
    ];
  const rows = isYear
    ? monthly.map((m) => ({
        date: m.month,
        value: m.metrics[key]?.value ?? null,
        metric: m.metrics[key],
        count: m.metrics[key]?.count ?? 0,
        dates: m.dates,
        recorded: m.recordedNights,
        total: m.totalSleep?.medianMinutes,
      }))
    : daily.map((d) => ({
        date: d.date,
        value: d.assessment?.metrics[key]?.value ?? null,
        metric: d.assessment?.metrics[key],
        sessionId: d.sessionId,
        total: d.totalSleep.minutesAsleep,
        rating: ratings.find((r) => r.date === d.date)?.restfulness,
      }));
  const numeric = rows.map((r) => r.value).filter(Number.isFinite),
    clock = ["bedtime", "wakeTime"].includes(key),
    plot = (v) => (clock ? (v < 720 ? v + 1440 : v) : v);
  const values = numeric.map(plot),
    maximum = Math.max(
      1,
      ...values,
      key === "duration" ? data.preferences.goalMinutes : 0,
    ),
    minimum = clock ? Math.min(...values, 1440) - 30 : 0,
    span = maximum - minimum || 1;
  return `<div class="sleep-section-heading"><div><p class="view-kicker">Your personal trends</p><h2>How nights compare</h2></div><div class="sleep-trend-controls">${[
    ["7", "7 days"],
    ["30", "30 days"],
    ["90", "90 days"],
    ["year", "1 year"],
  ]
    .map(
      ([value, label]) =>
        `<button class="button button-secondary" data-sleep-period="${value}" aria-pressed="${period === value}">${label}</button>`,
    )
    .join(
      "",
    )}</div></div><label class="sleep-trend-select">Measurement<select data-sleep-trend-metric>${metrics.map(([value, label]) => `<option value="${value}" ${key === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><p class="sleep-meta">${isYear ? "Monthly medians with recorded-night counts. Select a month to open a night." : "Daily measurements. Select a date to open its report."}${key === "duration" ? ` Goal: ${sleepDuration(data.preferences.goalMinutes)}. Bars show main sleep; totals including naps are listed below.` : ""}</p><div class="sleep-trend-chart" style="--sleep-columns:${Math.max(rows.length, 1)}">${[0, 0.5, 1].map(f => `<div class="lens-trend-grid" style="bottom:${f * 100}%"><span>${measurementLabel(rows.find(r => r.metric?.unit)?.metric ?? {}, clock ? minimum + span * f : maximum * f)}</span></div>`).join('')}${key === "duration" ? `<div class="sleep-trend-goal" style="bottom:${((data.preferences.goalMinutes - minimum) / span) * 100}%"><span>Goal</span></div>` : ""}${rows.map((r, index) => `<button class="sleep-trend-column" ${isYear ? `data-sleep-month="${r.date}"` : `data-sleep-date="${r.date}"`} title="${r.date}: ${measurementLabel(r.metric ?? {}, r.value)}${r.rating ? `; ${rested[r.rating - 1]}` : ""}" aria-label="${r.date}, ${measurementLabel(r.metric ?? {}, r.value)}"><span class="sleep-trend-bar ${r.value === null ? "is-missing" : ""}" style="height:${r.value === null ? 0 : Math.max(2, ((plot(r.value) - minimum) / span) * 100)}%"></span>${index % Math.ceil(rows.length / 7) === 0 || index === rows.length - 1 ? `<span class="sleep-trend-tick">${isYear ? r.date.slice(5) : r.date.slice(5).replace('-', '/')}</span>` : ''}${r.rating ? '<i class="sleep-rating-dot" aria-label="Check-in recorded"></i>' : ""}</button>`).join("")}</div><div data-sleep-month-dates></div><details class="sleep-trend-table"><summary>Values, totals &amp; recorded-night counts</summary><div class="sleep-table-scroll"><table><thead><tr><th>${isYear ? "Month" : "Date"}</th><th>${metrics.find((m) => m[0] === key)?.[1]}</th><th>${isYear ? "Usable / recorded nights" : "Total sleep + naps"}</th><th>${isYear ? "Median total + naps" : "Restfulness"}</th></tr></thead><tbody>${rows.map((r) => `<tr><td><button class="sleep-text-button" ${isYear ? `data-sleep-month="${r.date}"` : `data-sleep-date="${r.date}"`}>${r.date}</button></td><td>${measurementLabel(r.metric ?? {}, r.value)}</td><td>${isYear ? `${r.count} / ${r.recorded}` : sleepDuration(r.total)}</td><td>${isYear ? sleepDuration(r.total) : r.rating ? rested[r.rating - 1] : "Unanswered"}</td></tr>`).join("")}</tbody></table></div></details>`;
}
export function createSleepWorkspace({
  root,
  fetchJson,
  navigate,
  onResolved,
  notify,
}) {
  const patterns = createSleepPatterns({ root, fetchJson, notify });
  let mode = "sleep";
  let report = null,
    version = 0,
    trendVersion = 0,
    period = "30",
    metric = "duration",
    trendData = null,
    ratings = [],
    selection = {},
    entry = null;
  const fail = (error) => notify(error.message);
  function setMode(next) {
    mode = ['sleep','trends','patterns'].includes(next) ? next : 'sleep';
    root.dataset.lensMode = mode;
    for (const panel of root.querySelectorAll('[data-sleep-panel]')) panel.hidden = panel.dataset.sleepPanel !== mode;
    const title = root.querySelector('[data-sleep-page-title]');
    if (title) title.textContent = mode === 'sleep' ? (report?.date ? dateLabel(report.date) : 'Your sleep') : mode === 'trends' ? 'Your sleep, over time' : 'Patterns in your sleep';
    const copy = root.querySelector('[data-sleep-heading-copy]');
    if (copy) copy.textContent = mode === 'sleep' ? 'Time asleep. What changed. What the data supports.' : mode === 'trends' ? 'Look past a single night. Follow the changes across your history.' : 'Explore what changes alongside your sleep.';
    const kicker = root.querySelector('[data-sleep-kicker]');
    if (kicker) kicker.textContent = mode === 'sleep' ? 'Your night, in focus' : mode === 'trends' ? 'The longer view' : 'Put your nights in context';
  }
  function updateCheckInLabel() {
    const label = root.querySelector('[data-checkin-label]');
    if (label) label.innerHTML = `<span><strong>${entry ? 'Your morning check-in' : 'How did it feel?'}</strong><small>${entry ? `${entry.restfulness ? rested[entry.restfulness-1] : 'Restfulness unanswered'} · ${entry.context?.length ? escape(entry.context.join(', ')) : entry.contextReviewed ? 'No unusual factors' : 'Factors not reviewed'}` : 'Add restfulness and anything unusual to put the numbers in context.'}</small></span><span class="lens-checkin-action">${entry ? 'Edit check-in' : 'Add check-in'}</span>`;
  }
  async function loadTrends(token) {
    if (!report?.date) return;
    const requestVersion = ++trendVersion;
    const end = shift(report.date, 1),
      start = shift(end, period === "year" ? -365 : -Number(period)),
      sources = JSON.stringify(selection.sources ?? {});
    const results = await Promise.allSettled([
      fetchJson(
        `/api/sleep/trends?start=${start}&end=${end}&sources=${encodeURIComponent(sources)}`,
      ),
      fetchJson(`/api/sleep/check-ins?start=${start}&end=${end}`),
    ]);
    if (token !== version || requestVersion !== trendVersion) return;
    const target = root.querySelector("[data-sleep-trends]");
    if (!target) return;
    if (results[0].status === "rejected") {
      target.innerHTML =
        "<h2>Trends unavailable</h2><p>The night report is still available.</p>";
      return;
    }
    trendData = results[0].value;
    ratings = results[1].status === "fulfilled" ? results[1].value : [];
    target.innerHTML = trendsMarkup(trendData, period, metric, ratings);
  }
  async function load(next = {}) {
    patterns.cancel();
    selection = next;
    const token = ++version;
    root.innerHTML =
      '<div class="sleep-card" role="status">Loading your sleep report…</div>';
    const params = new URLSearchParams();
    if (next.date) params.set("date", next.date);
    if (next.sessionId) params.set("sessionId", next.sessionId);
    if (next.sources && Object.keys(next.sources).length)
      params.set("sources", JSON.stringify(next.sources));
    try {
      const data = await fetchJson(`/api/sleep/report?${params}`);
      if (token !== version) return;
      report = data;
      selection = {
        ...selection,
        date: report.date,
        sessionId: report.session?.id ?? null,
      };
      root.innerHTML = renderSleepReport(report);
      setMode(mode);
      onResolved(report);
      bindTimeline(root, report);
      const checkIn = root.querySelector("[data-sleep-check-in-container]");
      const privateLoad =
        report.checkInDate && checkIn
          ? fetchJson(`/api/sleep/check-ins/${report.checkInDate}`)
              .then((value) => {
                if (token !== version) return;
                entry = value;
                updateCheckInLabel();
                checkIn.innerHTML = checkInMarkup(report.checkInDate, entry);
              })
              .catch(() => {
                if (token === version)
                  checkIn.textContent =
                    "Check-in unavailable. Your sleep measurements are still available.";
              })
          : Promise.resolve();
      await Promise.all([privateLoad, loadTrends(token), patterns.load({ date: report.date, sources: selection.sources })]);
    } catch (error) {
      if (token === version)
        root.innerHTML = `<section class="sleep-card" role="alert"><h2>Sleep report unavailable</h2><p>${escape(error.message)}</p><button class="button button-secondary" data-sleep-latest>Open latest night</button></section>`;
    }
  }
  root.addEventListener("click", async (event) => {
    const target = event.target.closest("button,a");
    if (!target) return;
    if (target.dataset.evidence || target.dataset.indicator) {
      event.preventDefault();
      const node = root.querySelector(
        target.dataset.evidence
          ? `#sleep-evidence-${target.dataset.evidence}`
          : `#sleep-indicator-${target.dataset.indicator}`,
      );
      for (let parent = node; parent && parent !== root; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (target.hasAttribute("data-sleep-date"))
      navigate({
        ...selection,
        date: target.dataset.sleepDate,
        sessionId: null,
      }, target.hasAttribute("data-sleep-browse") ? mode : "sleep");
    if (target.hasAttribute("data-sleep-latest"))
      navigate({ ...selection, date: null, sessionId: null }, mode);
    if (target.dataset.sleepPeriod) {
      period = target.dataset.sleepPeriod;
      await Promise.all([loadTrends(version), ...(period === "year" ? [] : [patterns.setDays(Number(period))])]);
    }
    if (target.dataset.patternDays) { period = target.dataset.patternDays; await loadTrends(version); }
    if (target.dataset.sleepMonth) {
      const month = trendData?.months.find(
        (m) => m.month === target.dataset.sleepMonth,
      );
      root.querySelector("[data-sleep-month-dates]").innerHTML =
        `<p>${month?.recordedNights ?? 0} recorded nights in ${target.dataset.sleepMonth}</p><div class="sleep-month-dates">${month?.dates.map((date) => `<button class="button button-secondary" data-sleep-date="${date}">${date.slice(8)}</button>`).join("") ?? ""}</div>`;
    }
    if (target.hasAttribute("data-sleep-skip"))
      root.querySelector("[data-sleep-check-in-container]").innerHTML =
        '<p>Skipped. No answers were inferred.</p><button class="button button-secondary" data-sleep-resume>Open check-in</button>';
    if (target.hasAttribute("data-sleep-resume"))
      root.querySelector("[data-sleep-check-in-container]").innerHTML =
        checkInMarkup(report.checkInDate, entry);
    if (target.hasAttribute("data-sleep-delete")) {
      const token = version,
        date = report.checkInDate;
      try {
        await fetchJson(`/api/sleep/check-ins/${date}`, {
          method: "DELETE",
        });
        if (token !== version) return;
        entry = null;
        updateCheckInLabel();
        root.querySelector("[data-sleep-check-in-container]").innerHTML =
          checkInMarkup(report.checkInDate, null);
        notify("Check-in deleted.");
        await Promise.all([loadTrends(version), patterns.refresh()]);
      } catch (error) {
        fail(error);
      }
    }
  });
  root.addEventListener("change", (event) => {
    const target = event.target;
    if (target.name === 'contextNone' && target.checked)
      for (const input of root.querySelectorAll('input[name="context"]')) input.checked = false;
    if (target.name === 'context' && target.checked) {
      const none = root.querySelector('input[name="contextNone"]');
      if (none) none.checked = false;
    }
    if (target.hasAttribute("data-sleep-calendar") && target.value)
      navigate({ ...selection, date: target.value, sessionId: null }, mode);
    if (target.hasAttribute("data-sleep-session"))
      navigate({ ...selection, date: report.date, sessionId: target.value });
    if (target.hasAttribute("data-sleep-source")) {
      const sources = { ...selection.sources };
      if (target.value) sources[target.dataset.sleepSource] = target.value;
      else delete sources[target.dataset.sleepSource];
      navigate({
        ...selection,
        date: report.date,
        sessionId: report.session?.id ?? null,
        sources,
      }, mode);
    }
    if (target.hasAttribute("data-sleep-trend-metric")) {
      metric = target.value;
      root.querySelector("[data-sleep-trends]").innerHTML = trendsMarkup(
        trendData,
        period,
        metric,
        ratings,
      );
    }
  });
  root.addEventListener("reset", (event) => {
    if (event.target.hasAttribute("data-sleep-check-in")) {
      event.preventDefault();
      for (const input of event.target.querySelectorAll("input"))
        input.checked = false;
      event.target.querySelector("textarea").value = "";
    }
  });
  root.addEventListener("submit", async (event) => {
    const form = event.target;
    if (
      !form.hasAttribute("data-sleep-check-in") &&
      !form.hasAttribute("data-sleep-goal")
    )
      return;
    event.preventDefault();
    const data = new FormData(form),
      submit = form.querySelector('[type="submit"]');
    const token = version,
      date = report.checkInDate;
    submit.disabled = true;
    try {
      if (form.hasAttribute("data-sleep-goal")) {
        await fetchJson("/api/sleep/preferences", {
          method: "PUT",
          body: JSON.stringify({
            goalMinutes: Number(data.get("goalMinutes")),
          }),
        });
        if (token !== version) return;
        await load(selection);
        notify("Sleep goal updated.");
      } else {
        const body = {
          restfulness: data.has("restfulness")
            ? Number(data.get("restfulness"))
            : null,
          awakenings: data.has("awakenings")
            ? Number(data.get("awakenings"))
            : null,
          context: data.getAll("context"),
          contextReviewed: data.has('contextNone') || data.getAll('context').length > 0,
          note: data.get("note"),
        };
        const saved = await fetchJson(`/api/sleep/check-ins/${date}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        if (token !== version) return;
        entry = saved;
        updateCheckInLabel();
        root.querySelector("[data-sleep-checkin-disclosure]").open = false;
        root.querySelector("[data-sleep-check-in-container]").innerHTML =
          checkInMarkup(report.checkInDate, entry);
        notify("Check-in saved.");
        await Promise.all([loadTrends(version), patterns.refresh()]);
      }
    } catch (error) {
      fail(error);
    } finally {
      submit.disabled = false;
    }
  });
  return {
    load,
    setMode,
    openCheckIn() { const panel = root.querySelector("[data-sleep-checkin-disclosure]"); if (panel) { panel.open = true; panel.scrollIntoView({ block: "center" }); } },
    cancel() {
      version++;
      patterns.cancel();
    },
  };
}
