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
  return `<form data-sleep-check-in><p class="sleep-meta">Optional · morning of ${escape(date)}. Leave any answer blank.</p><fieldset><legend>How rested do you feel?</legend><div class="sleep-rating-options">${rested.map((text, i) => `<label><input type="radio" name="restfulness" value="${i + 1}" ${entry?.restfulness === i + 1 ? "checked" : ""}/><span>${text}</span></label>`).join("")}</div></fieldset><fieldset><legend>How many awakenings do you remember?</legend><div class="sleep-choice-options">${[0, 1, 2, 3].map((n) => `<label><input type="radio" name="awakenings" value="${n}" ${entry?.awakenings === n ? "checked" : ""}/><span>${n === 3 ? "3+" : n}</span></label>`).join("")}</div></fieldset><fieldset><legend>Anything unusual?</legend><div class="sleep-choice-options">${contexts.map((c) => `<label><input type="checkbox" name="context" value="${c}" ${entry?.context?.includes(c) ? "checked" : ""}/><span>${c}</span></label>`).join("")}</div></fieldset><label class="sleep-note-label">Optional note<textarea name="note" rows="2" maxlength="2000" placeholder="A little context for this night">${escape(entry?.note ?? "")}</textarea></label><div class="sleep-form-actions"><button class="button button-primary" type="submit">${entry ? "Update" : "Save"} check-in</button><button class="button button-secondary" type="button" data-sleep-skip>Skip</button><button class="button button-secondary" type="reset">Clear answers</button>${entry ? '<button class="button button-secondary" type="button" data-sleep-delete>Delete</button>' : ""}</div><p class="sleep-meta">Encrypted with your journal key. Context is recorded without inferring its effects.</p></form>`;
}
function reportMarkup(report) {
  const date = report.date,
    session = report.session,
    a = report.assessment,
    dates = report.dates ?? [],
    index = dates.indexOf(date);
  const header = `<div class="sleep-heading"><div><p class="view-kicker">Sleep overview</p><h1>${date ? dateLabel(date) : "Your sleep"}</h1><p>Time asleep. What changed. What the data supports.</p></div><div class="sleep-date-controls"><button class="button button-secondary" data-sleep-date="${dates[index + 1] ?? (date ? shift(date, -1) : "")}" ${!date ? "disabled" : ""} aria-label="Previous recorded night">←</button><label><span class="sr-only">Sleep wake date</span><input type="date" data-sleep-calendar value="${date ?? ""}"/></label><button class="button button-secondary" data-sleep-date="${dates[index - 1] ?? (date ? shift(date, 1) : "")}" ${!date || date >= dates[0] ? "disabled" : ""} aria-label="Next recorded night">→</button><button class="button button-secondary" data-sleep-latest>Latest night</button></div></div>`;
  if (!session)
    return `${header}<section class="sleep-card"><h2>No sleep recorded${date ? " on this date" : ""}</h2><p>Available measurements and saved history will remain intact. Sync can fetch newly processed records.</p></section><section data-sleep-trends class="sleep-card"></section>`;
  const primary =
    report.mainSessionId === session.id
      ? "Main sleep"
      : session.isNap
        ? "Nap"
        : "Additional sleep";
  const signalSources = Object.entries(report.physiology)
    .map(([key, m]) => sourceSelect(key, m))
    .join("");
  return `${header}<div class="sleep-session-row"><label>Session<select data-sleep-session>${report.sessions.map((s) => `<option value="${s.id}" ${s.id === session.id ? "selected" : ""}>${s.id === report.mainSessionId ? "Main sleep" : s.isNap ? "Nap" : "Additional sleep"} · ${sleepDuration(s.minutesAsleep)} · ${recordedTime(s.startTime, s.startOffsetSeconds, report.timezone)}–${recordedTime(s.endTime, s.endOffsetSeconds, report.timezone)}</option>`).join("")}</select></label>${a.provisional ? '<span class="sleep-badge">Provisional</span>' : ""}<details class="sleep-data-status"><summary>${a.notes.length ? "Some data unavailable" : "Data details"}</summary><p>Newest measurement in this report: ${escape(report.newestMeasurementAt)}.</p><p>Sleep processing: ${session.processed === true ? "complete" : session.processed === false ? "pending" : "not provided"}. Stages: ${escape(session.metadata.stagesStatus ?? "status not provided")}.</p>${Object.entries(
    report.availability,
  )
    .map(
      ([key, v]) =>
        `<p><strong>${key}</strong>: ${v.permissionDenied ? "permission denied" : v.lastAttemptStatus}${v.fetchComplete ? " · completed fetch" : ""} · ${v.observationState ?? "not loaded"}<br/>Last successful fetch: ${escape(v.lastSuccessfulFetchAt ?? "not recorded")}. ${v.reliability}</p>`,
    )
    .join(
      "",
    )}<p>Missing measurements are not evidence that all signals are normal. An empty completed fetch does not establish device support.</p></details></div>
    <div class="sleep-overview-grid"><div class="sleep-main-column"><section class="sleep-card sleep-report-card"><p class="view-kicker">${primary} · actual time asleep</p><div class="sleep-primary-number">${sleepDuration(session.minutesAsleep)}</div><div class="sleep-secondary-numbers"><span>${sleepDuration(session.durationMinutes)} recorded period</span><span>${sleepDuration(session.minutesAwake)} awake</span><span>${sleepDuration(report.totalSleep.minutesAsleep)} total including naps</span></div>${report.totalSleep.reason ? `<p class="sleep-data-note">Combined total unavailable: ${escape(report.totalSleep.reason)}.</p>` : ""}${renderSleepAssessment(a)}<div class="sleep-indicators">${a.indicators.map((indicator) => `<a href="#sleep-indicator-${indicator.key}" data-indicator="${indicator.key}"><span>${indicator.label}</span><strong>${indicator.key === "duration" ? (session.isNap ? "Nap" : a.metrics.duration.goalDifferenceMinutes < 0 ? "Below goal" : "Goal met") : indicator.metrics.every((k) => a.metrics[k].assessable) ? (indicator.metrics.some((k) => ["above", "below"].includes(a.metrics[k].baseline.comparison)) ? "Changed" : "In recent range") : indicator.key === "signals" ? "Partial data" : "Building baseline"}</strong></a>`).join("")}</div><details class="sleep-goal"><summary>Sleep goal · ${sleepDuration(report.preferences.goalMinutes)}</summary><form data-sleep-goal><label>Chosen goal in minutes<input name="goalMinutes" type="number" min="60" max="1440" step="1" value="${report.preferences.goalMinutes}" required/></label><button class="button button-secondary" type="submit">Update goal</button></form><p>This preference is separate from your recent sleep baseline.</p></details></section>
    ${timelineMarkup(report)}<section data-sleep-trends class="sleep-card"></section>
    <section class="sleep-card"><h2>What supports this assessment?</h2><p class="sleep-meta">Recent range = your previous 28 calendar days, excluding this night. At least 14 usable nights per measurement. Historical comparisons, not clinical reference intervals.</p>${a.indicators.map((i) => `<div id="sleep-indicator-${i.key}" class="sleep-indicator-detail"><h3>${i.label}</h3>${i.metrics.map((key) => evidence(a.metrics[key], key)).join("")}</div>`).join("")}</section></div>
    <aside class="sleep-side-column"><section class="sleep-card"><h2>Morning check-in</h2><div data-sleep-check-in-container>${report.checkInDate ? "Loading your optional check-in…" : "Available when a main sleep is recorded for this wake date."}</div></section><section class="sleep-card"><p class="view-kicker">Provider date · ${date}</p><h2>Supporting measurements</h2><p class="sleep-meta">Daily values are associated with this date, including when you select a nap.</p>${["hrv", "breathing", "temperature", "spo2"].map((key) => `<div class="sleep-supporting-measurement"><span>${a.metrics[key].label}</span><strong>${measurementLabel(a.metrics[key])}</strong></div>`).join("")}<div class="sleep-supporting-measurement"><span>Sleep-onset latency</span><strong>${sleepDuration(session.timeToSleepMinutes)}</strong></div><details><summary>Sources &amp; provider details</summary>${signalSources}<p>Respiratory sleep summaries: ${report.respiratorySummaries.length} records. These are summaries, not continuous breathing traces.</p>${report.respiratorySummaries.map((s) => `<p>${s.providerDate} · ${escape(s.sampledAt)} · ${s.breathsPerMinute ?? "Unavailable"} breaths/min</p>`).join("")}<p>Temperature baselines, quality fields, and complete provider records are retained in exports.</p></details></section></aside></div>`;
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
    ["year", "1 year"],
  ]
    .map(
      ([value, label]) =>
        `<button class="button button-secondary" data-sleep-period="${value}" aria-pressed="${period === value}">${label}</button>`,
    )
    .join(
      "",
    )}</div></div><label class="sleep-trend-select">Measurement<select data-sleep-trend-metric>${metrics.map(([value, label]) => `<option value="${value}" ${key === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><p class="sleep-meta">${isYear ? "Monthly medians with recorded-night counts. Select a month to open a night." : "Daily measurements. Select a date to open its report."}${key === "duration" ? ` Goal: ${sleepDuration(data.preferences.goalMinutes)}. Bars show main sleep; totals including naps are listed below.` : ""}</p><div class="sleep-trend-chart" style="--sleep-columns:${Math.max(rows.length, 1)}">${key === "duration" ? `<div class="sleep-trend-goal" style="bottom:${((data.preferences.goalMinutes - minimum) / span) * 100}%"><span>Goal</span></div>` : ""}${rows.map((r) => `<button class="sleep-trend-column" ${isYear ? `data-sleep-month="${r.date}"` : `data-sleep-date="${r.date}"`} title="${r.date}: ${measurementLabel(r.metric ?? {}, r.value)}${r.rating ? `; ${rested[r.rating - 1]}` : ""}" aria-label="${r.date}, ${measurementLabel(r.metric ?? {}, r.value)}"><span class="sleep-trend-bar ${r.value === null ? "is-missing" : ""}" style="height:${r.value === null ? 0 : Math.max(2, ((plot(r.value) - minimum) / span) * 100)}%"></span><span class="sleep-trend-tick">${isYear ? r.date.slice(5) : r.date.slice(8)}</span>${r.rating ? '<i class="sleep-rating-dot" aria-label="Check-in recorded"></i>' : ""}</button>`).join("")}</div><div data-sleep-month-dates></div><details class="sleep-trend-table"><summary>Values, totals &amp; recorded-night counts</summary><div class="sleep-table-scroll"><table><thead><tr><th>${isYear ? "Month" : "Date"}</th><th>${metrics.find((m) => m[0] === key)?.[1]}</th><th>${isYear ? "Usable / recorded nights" : "Total sleep + naps"}</th><th>${isYear ? "Median total + naps" : "Restfulness"}</th></tr></thead><tbody>${rows.map((r) => `<tr><td><button class="sleep-text-button" ${isYear ? `data-sleep-month="${r.date}"` : `data-sleep-date="${r.date}"`}>${r.date}</button></td><td>${measurementLabel(r.metric ?? {}, r.value)}</td><td>${isYear ? `${r.count} / ${r.recorded}` : sleepDuration(r.total)}</td><td>${isYear ? sleepDuration(r.total) : r.rating ? rested[r.rating - 1] : "Unanswered"}</td></tr>`).join("")}</tbody></table></div></details>`;
}
export function createSleepWorkspace({
  root,
  fetchJson,
  navigate,
  onResolved,
  notify,
}) {
  let report = null,
    version = 0,
    trendVersion = 0,
    period = "7",
    metric = "duration",
    trendData = null,
    ratings = [],
    selection = {},
    entry = null;
  const fail = (error) => notify(error.message);
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
      root.innerHTML = reportMarkup(report);
      onResolved(report);
      bindTimeline(root, report);
      const checkIn = root.querySelector("[data-sleep-check-in-container]");
      const privateLoad =
        report.checkInDate && checkIn
          ? fetchJson(`/api/sleep/check-ins/${report.checkInDate}`)
              .then((value) => {
                if (token !== version) return;
                entry = value;
                checkIn.innerHTML = checkInMarkup(report.checkInDate, entry);
              })
              .catch(() => {
                if (token === version)
                  checkIn.textContent =
                    "Check-in unavailable. Your sleep measurements are still available.";
              })
          : Promise.resolve();
      await Promise.all([privateLoad, loadTrends(token)]);
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
      if (node?.tagName === "DETAILS") node.open = true;
      node?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (target.hasAttribute("data-sleep-date"))
      navigate({
        ...selection,
        date: target.dataset.sleepDate,
        sessionId: null,
      });
    if (target.hasAttribute("data-sleep-latest"))
      navigate({ ...selection, date: null, sessionId: null });
    if (target.dataset.sleepPeriod) {
      period = target.dataset.sleepPeriod;
      await loadTrends(version);
    }
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
        root.querySelector("[data-sleep-check-in-container]").innerHTML =
          checkInMarkup(report.checkInDate, null);
        notify("Check-in deleted.");
        await loadTrends(version);
      } catch (error) {
        fail(error);
      }
    }
  });
  root.addEventListener("change", (event) => {
    const target = event.target;
    if (target.hasAttribute("data-sleep-calendar") && target.value)
      navigate({ ...selection, date: target.value, sessionId: null });
    if (target.hasAttribute("data-sleep-session"))
      navigate({ ...selection, date: report.date, sessionId: target.value });
    if (target.hasAttribute("data-sleep-source")) {
      const sources = { ...selection.sources };
      if (target.value) sources[target.dataset.sleepSource] = target.value;
      else delete sources[target.dataset.sleepSource];
      navigate({
        ...selection,
        date: report.date,
        sessionId: report.session.id,
        sources,
      });
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
          note: data.get("note"),
        };
        const saved = await fetchJson(`/api/sleep/check-ins/${date}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        if (token !== version) return;
        entry = saved;
        root.querySelector("[data-sleep-check-in-container]").innerHTML =
          checkInMarkup(report.checkInDate, entry);
        notify("Check-in saved.");
        await loadTrends(version);
      }
    } catch (error) {
      fail(error);
    } finally {
      submit.disabled = false;
    }
  });
  return {
    load,
    cancel() {
      version++;
    },
  };
}
