function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function titleCase(value) {
  return String(value ?? '')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatValue(value) {
  if (value === null || value === undefined) {
    return '<span class="inspector-missing-value">missing</span>';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
  return escapeHtml(value);
}

function formatSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds === 0) return '0s';
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? `${hours}h` : `${Math.round(hours * 10) / 10}h`;
}

function formatTimestamp(value) {
  if (!value) return 'unavailable';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return String(value);
  return new Date(timestamp).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function badge(label, kind) {
  return `<span class="inspector-badge" data-kind="${kind}">${escapeHtml(label)}</span>`;
}

function statusBadges(data) {
  const labels = [badge('Google / source facts', 'source')];
  if (
    ['sleep', 'calories'].includes(data.category)
    || (
      data.category === 'heart'
      && data.sourceFacts?.dataTypes?.includes('daily-resting-heart-rate')
    )
  ) {
    labels.push(badge('Google inferred / estimated', 'google-inferred'));
  }
  if (data.status !== 'available') labels.push(badge('Missing / unknown detail', 'missing'));
  return labels.join('');
}

function summaryMarkup(summary = {}) {
  const entries = Object.entries(summary ?? {});
  if (!entries.length) return '<p class="inspector-empty">No normalized daily summary is stored.</p>';
  return `<dl class="inspector-summary-grid">
    ${entries
      .map(
        ([field, value]) => `<div>
          <dt>${escapeHtml(field)}</dt>
          <dd>${formatValue(value)}</dd>
        </div>`,
      )
      .join('')}
  </dl>`;
}

function fieldDefinitionsMarkup(definitions = []) {
  if (!definitions.length) return '';
  return `<div class="inspector-table-wrap">
    <table class="inspector-table inspector-schema-table">
      <caption>Stored field meanings</caption>
      <thead><tr><th>Field</th><th>Datatype</th><th>Unit</th><th>Meaning</th></tr></thead>
      <tbody>
        ${definitions
          .map(
            (field) => `<tr>
              <td><code>${escapeHtml(field.field)}</code></td>
              <td>${escapeHtml(field.type)}</td>
              <td>${escapeHtml(field.unit ?? '—')}</td>
              <td>${escapeHtml(field.meaning)}</td>
            </tr>`,
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

export function inspectorRecordRows(items = [], fields = null) {
  const names = fields?.length ? fields : Object.keys(items[0] ?? {});
  return items
    .map(
      (item) => `<tr>${names.map((field) => `<td>${formatValue(item[field])}</td>`).join('')}</tr>`,
    )
    .join('');
}

function recordsMarkup(records = {}) {
  const items = records.items ?? [];
  if (!items.length) {
    return '<p class="inspector-empty">No fine-grained normalized records remain online for this date.</p>';
  }
  const fields = Object.keys(items[0]);
  return `<div class="inspector-table-wrap">
    <table class="inspector-table" data-inspector-record-table>
      <caption>${Number(records.total ?? items.length).toLocaleString()} normalized records</caption>
      <thead><tr>${fields.map((field) => `<th>${escapeHtml(field)}</th>`).join('')}</tr></thead>
      <tbody>${inspectorRecordRows(items, fields)}</tbody>
    </table>
  </div>
  ${records.nextCursor
    ? `<button class="button button-secondary button-compact inspector-load-more"
        type="button" data-load-inspector-records data-cursor="${escapeHtml(records.nextCursor)}">
        Load more normalized records
      </button>`
    : ''}`;
}

function sourceFactsMarkup(data) {
  const facts = data.sourceFacts ?? {};
  const types = facts.dataTypes?.length
    ? facts.dataTypes.map((type) => `<code>${escapeHtml(type)}</code>`).join('')
    : '<span class="inspector-missing-value">none retained</span>';
  const devices = facts.devices?.length
    ? facts.devices.map((device) => `<li>${formatValue(device)}</li>`).join('')
    : '<li>Source device metadata unavailable.</li>';
  const metadata = facts.metadata?.length
    ? `<div class="inspector-devices"><span>Other redacted source metadata</span><ul>${
        facts.metadata.map((item) => `<li>${formatValue(item)}</li>`).join('')
      }</ul></div>`
    : '';
  return `<article class="inspector-layer">
    <div class="inspector-layer-heading">
      <div><p class="inspector-eyebrow">Layer 1</p><h4>Google / source facts</h4></div>
      <div class="inspector-badges">${statusBadges(data)}</div>
    </div>
    <div class="inspector-fact-grid">
      <div><span>Data types</span><div class="inspector-code-list">${types}</div></div>
      <div><span>Source records</span><strong>${Number(facts.recordCount ?? 0).toLocaleString()}</strong></div>
      <div><span>Unit</span><strong>${escapeHtml(facts.unit ?? 'varies')}</strong></div>
      <div><span>Source window</span><strong>${escapeHtml(formatTimestamp(facts.window?.startTime))}<br>→ ${escapeHtml(formatTimestamp(facts.window?.endTime))}</strong></div>
    </div>
    <div class="inspector-devices"><span>Source/device descriptions</span><ul>${devices}</ul></div>
    ${metadata}
  </article>`;
}

function normalizedMarkup(data) {
  return `<article class="inspector-layer">
    <div class="inspector-layer-heading">
      <div><p class="inspector-eyebrow">Layer 2</p><h4>Normalized database records</h4></div>
      <div class="inspector-badges">${badge('Normalized', 'normalized')}</div>
    </div>
    ${summaryMarkup(data.normalized?.summary)}
    ${fieldDefinitionsMarkup(data.normalized?.fieldDefinitions)}
    ${recordsMarkup(data.records)}
  </article>`;
}

function derivedMarkup(derived = []) {
  return `<article class="inspector-layer">
    <div class="inspector-layer-heading">
      <div><p class="inspector-eyebrow">Layer 3</p><h4>Application-derived values</h4></div>
      <div class="inspector-badges">${badge('Application derived', 'derived')}</div>
    </div>
    ${derived.length
      ? `<div class="inspector-formulas">
          ${derived
            .map(
              (item) => `<div>
                <div><code>${escapeHtml(item.field)}</code><strong>${formatValue(item.value)}${item.unit ? ` <small>${escapeHtml(item.unit)}</small>` : ''}</strong></div>
                <p><span>Formula</span><code>${escapeHtml(item.formula)}</code></p>
                <p><span>Inputs</span>${escapeHtml((item.inputFields ?? []).join(', ') || 'not recorded')}</p>
                <p><span>Input state</span>${formatValue(item.inputState)}</p>
              </div>`,
            )
            .join('')}
        </div>`
      : '<p class="inspector-empty">No application-created values are stored for this category/date.</p>'}
  </article>`;
}

function coverageMarkup(data) {
  const coverage = data.coverage ?? {};
  const age = data.dataAge ?? {};
  return `<article class="inspector-layer">
    <div class="inspector-layer-heading">
      <div><p class="inspector-eyebrow">Quality</p><h4>Coverage, gaps, and freshness</h4></div>
      <div class="inspector-badges">${badge(
        coverage.storedState === 'missing' ? 'Missing / unknown' : titleCase(coverage.storedState),
        coverage.storedState === 'missing' ? 'missing' : 'coverage',
      )}</div>
    </div>
    <div class="inspector-age-grid">
      <div><span>Civil day</span><strong>${formatSeconds(coverage.civilDaySeconds)}</strong></div>
      <div><span>Stored coverage</span><strong>${formatSeconds(coverage.storedCoverageSeconds)}</strong></div>
      <div><span>Last successful sync</span><strong>${escapeHtml(formatTimestamp(age.lastSuccessfulSync))}</strong></div>
      <div><span>Source updated</span><strong>${escapeHtml(formatTimestamp(age.sourceUpdatedAt))}</strong></div>
    </div>
    <div class="inspector-streams">
      ${(coverage.streams ?? [])
        .map(
          (stream) => `<div>
            <div><code>${escapeHtml(stream.name)}</code>${badge(titleCase(stream.valueState), stream.valueState === 'missing' ? 'missing' : 'coverage')}</div>
            <dl>
              <div><dt>Records</dt><dd>${Number(stream.recordCount ?? 0).toLocaleString()}</dd></div>
              <div><dt>Covered</dt><dd>${formatSeconds(stream.coverageSeconds)}</dd></div>
              <div><dt>Gaps</dt><dd>${formatSeconds(stream.gapSeconds)}</dd></div>
            </dl>
            <p>${escapeHtml(stream.zeroSemantics)}</p>
          </div>`,
        )
        .join('')}
    </div>
    ${(coverage.limitations ?? []).length
      ? `<ul class="inspector-limitations">${coverage.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : ''}
  </article>`;
}

function sourceDisclosureMarkup(sourceJson = {}) {
  const unavailable = sourceJson.state === 'unavailable';
  return `<details class="inspector-source" data-inspector-source data-source-state="${escapeHtml(sourceJson.state)}">
    <summary>
      <span><strong>Redacted source JSON</strong><small>${escapeHtml(titleCase(sourceJson.state))} · ${Number(sourceJson.recordCount ?? 0).toLocaleString()} records</small></span>
      <span aria-hidden="true">Open JSON</span>
    </summary>
    <div class="inspector-source-content" data-inspector-source-content>
      ${unavailable
        ? `<p class="inspector-empty">${escapeHtml(sourceJson.reason || 'The original payload is unavailable.')}</p>`
        : '<p class="inspector-empty">Source JSON loads only when this disclosure is opened.</p>'}
    </div>
  </details>`;
}

export function inspectorCategoryMarkup(data) {
  return `<div class="inspector-category-content" data-category="${escapeHtml(data.category)}">
    ${sourceFactsMarkup(data)}
    ${normalizedMarkup(data)}
    ${derivedMarkup(data.derived ?? [])}
    ${coverageMarkup(data)}
    ${sourceDisclosureMarkup(data.sourceJson)}
  </div>`;
}

export function needsInspectorLoad({ open, loadedDate, selectedDate }) {
  return Boolean(open && loadedDate !== selectedDate);
}

export function inspectorEndpoint(
  category,
  date,
  { source = false, cursor = null, limit = source ? 20 : 100 } = {},
) {
  const path = `/api/inspector/${encodeURIComponent(category)}${source ? '/source' : ''}`;
  const params = [`date=${encodeURIComponent(date)}`, `limit=${encodeURIComponent(limit)}`];
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  return `${path}?${params.join('&')}`;
}

export function renderSourceJson(target, payload) {
  target.textContent = JSON.stringify(payload, null, 2);
}
