const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const number = value => Number.isFinite(value) ? String(Number(value.toFixed(1))) : 'Unavailable';
const reason = code => ({ 'insufficient-observations': 'Not enough usable nights', 'mixed-sources-or-methods': 'Sources or methods differ' }[code] ?? code);
const dates = values => values.length ? values.map(date => `<button class="sleep-text-button" data-sleep-date="${date}">${date}</button>`).join(' · ') : 'None';
const difference = (value, unit) => value.reason ? escape(reason(value.reason)) : `${value.value > 0 ? '+' : ''}${number(value.value)} ${unit === '%' ? 'percentage points' : unit}`;
function comparison(group) {
  return `<details class="sleep-pattern-group"><summary>${escape(group.firstLabel)} versus ${escape(group.secondLabel)}</summary><div class="sleep-table-scroll"><table><thead><tr><th>Measurement</th><th>${escape(group.firstLabel)}</th><th>${escape(group.secondLabel)}</th><th>Difference</th></tr></thead><tbody>${Object.values(group.metrics).map(m => `<tr><th>${escape(m.label)} (${escape(m.unit)})</th><td>${number(m.first.value)}<br/><small>${m.first.count} nights</small></td><td>${number(m.second.value)}<br/><small>${m.second.count} nights</small></td><td>${difference(m.difference, m.unit)}<details><summary>Supporting dates</summary><p>First: ${dates(m.first.dates)}</p><p>Second: ${dates(m.second.dates)}</p></details></td></tr>`).join('')}</tbody></table></div></details>`;
}
export function renderSleepPatterns(data, { includeCheckIns = false } = {}) {
  return `<div class="sleep-section-heading"><div><p class="view-kicker">Comparisons and recorded habits</p><h2>Patterns over time</h2></div><div class="sleep-pattern-controls">${[7, 30, 90].map(days => `<button class="button button-secondary" data-pattern-days="${days}" aria-pressed="${data.days === days}">${days} days</button>`).join('')}</div></div>
    <p>${data.current.startDate}–${data.date}, compared with the preceding ${data.days} days. Goal: ${data.goalMinutes} minutes. Main sleep only; naps stay separate.</p>
    ${Object.entries(data.sourceChoices ?? {}).filter(([, choices]) => choices.length > 1).map(([key, choices]) => `<label class="sleep-source-label">${escape(key)} source<select data-sleep-source="${key}"><option value="">Automatic when unambiguous</option>${choices.map(s => `<option value="${s.key}" ${data.sources[key] === s.key ? 'selected' : ''}>${escape(s.label)} · ${s.key.slice(0, 8)}</option>`).join('')}</select></label>`).join('')}
    <div class="sleep-report-actions"><button class="button button-secondary" data-pattern-copy>Copy sleep report</button><button class="button button-secondary" data-pattern-download>Download Markdown</button></div>
    <label class="check-row"><input type="checkbox" data-pattern-private ${includeCheckIns ? 'checked' : ''}/><span>Include check-in ratings and context tags in the report</span></label>
    <p class="sleep-meta">Free-text notes and journal content stay out of this concise report. Nothing is sent to an AI service.</p><div data-pattern-fallback hidden><label>Copy this report<textarea readonly rows="12" aria-label="Sleep report text"></textarea></label></div>
    <div class="sleep-table-scroll"><table class="sleep-comparison-table"><thead><tr><th>Measurement</th><th>Current</th><th>Previous</th><th>Change</th></tr></thead><tbody>${Object.entries(data.current.metrics).map(([key, m]) => {
      const p = data.previous.metrics[key];
      return `<tr><th>${escape(m.label)} <small>(${escape(m.unit)})</small></th><td>${number(m.value)}<br/><small>${m.count}/${data.days} nights</small></td><td>${number(p.value)}<br/><small>${p.count}/${data.days} nights</small></td><td>${difference(data.differences[key], m.unit)}<details><summary>Counts and dates</summary><p>Requires ${m.required} usable nights in each period.</p><p>Current: ${dates(m.dates)}</p><p>Previous: ${dates(p.dates)}</p></details></td></tr>`;
    }).join('')}</tbody></table></div>
    <p class="sleep-meta">${escape(data.rules.consistency)} Each dimension stands on its own. A higher or lower physiological measurement is not automatically better or worse.</p>
    <h3>Restfulness and logged factors</h3><p class="sleep-meta">${escape(data.rules.habits)} Only explicitly reviewed nights can establish that a factor was absent.</p>
    ${data.checkInComparisons?.available ? `${comparison(data.checkInComparisons.restfulness)}<details><summary>Neutral and unanswered ratings</summary><p>Neutral (3): ${dates(data.checkInComparisons.restfulness.neutralDates)}</p><p>Unanswered: ${dates(data.checkInComparisons.restfulness.unansweredDates)}</p></details>${data.checkInComparisons.factors.map(comparison).join('')}` : '<p>Check-in comparisons are unavailable until encrypted check-ins are configured.</p>'}
    <details class="sleep-pattern-availability"><summary>Fetch coverage and missing measurements</summary>${Object.entries(data.availability).map(([key, a]) => `<p><strong>${escape(key)}</strong>: ${escape(a.observationState)} · ${a.recordCount} stored observations in the fetch window. Last successful fetch: ${escape(a.lastSuccessfulFetchAt ?? 'Never')}.${a.errorCode ? ` ${escape(a.errorCode)}${a.httpStatus ? ` (HTTP ${a.httpStatus})` : ''}.` : ''}</p>`).join('')}<p>${escape(data.rules.missing)}</p></details>`;
}
export async function copySleepReport(markdown, { clipboard, fallback }) {
  try {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable');
    await clipboard.writeText(markdown);
    return true;
  } catch {
    fallback(markdown);
    return false;
  }
}
export function createSleepPatterns({ root, fetchJson, notify }) {
  let date = null, sources = {}, days = 30, includeCheckIns = false, version = 0;
  const target = () => root.querySelector('[data-sleep-patterns]');
  const parameters = () => new URLSearchParams({ date, days: String(days), sources: JSON.stringify(sources) });
  async function refresh() {
    const token = ++version, element = target();
    if (!date || !element) return;
    element.innerHTML = '<h2>Patterns over time</h2><p role="status">Loading comparisons…</p>';
    try {
      const data = await fetchJson(`/api/sleep/insights?${parameters()}`);
      if (token === version && target() === element) element.innerHTML = renderSleepPatterns(data, { includeCheckIns });
    } catch {
      if (token === version && target() === element) element.innerHTML = '<h2>Patterns over time</h2><p>Comparisons are unavailable. Your nightly report remains available.</p><button class="button button-secondary" data-pattern-retry>Retry comparisons</button>';
    }
  }
  root.addEventListener('change', event => {
    if (event.target.hasAttribute('data-pattern-private')) {
      includeCheckIns = event.target.checked;
      version++;
      const fallback = target()?.querySelector('[data-pattern-fallback]');
      if (fallback) { fallback.hidden = true; fallback.querySelector('textarea').value = ''; }
    }
  });
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-pattern-days')) { days = Number(button.dataset.patternDays); await refresh(); }
    if (button.hasAttribute('data-pattern-retry')) await refresh();
    if (!button.hasAttribute('data-pattern-copy') && !button.hasAttribute('data-pattern-download')) return;
    const token = version, element = target(), params = parameters();
    params.set('includeSleepCheckIns', String(includeCheckIns));
    button.disabled = true;
    try {
      const report = await fetchJson(`/api/sleep/summary?${params}`);
      if (token !== version || target() !== element) return;
      if (button.hasAttribute('data-pattern-download')) {
        const url = URL.createObjectURL(new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = `sleep-${date}-${days}days.md`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const copied = await copySleepReport(report.markdown, { clipboard: globalThis.navigator?.clipboard, fallback: markdown => {
          if (token !== version || target() !== element) return;
          const holder = element.querySelector('[data-pattern-fallback]'), input = holder.querySelector('textarea');
          holder.hidden = false; input.value = markdown; input.focus(); input.select();
        } });
        if (token === version) notify(copied ? 'Sleep report copied.' : 'Select and copy the report text below the controls.');
      }
    } catch (error) { if (token === version) notify(error.message); }
    finally { button.disabled = false; }
  });
  return { load(selection) { date = selection.date; sources = selection.sources ?? {}; return refresh(); },
    refresh, cancel() { version++; } };
}
