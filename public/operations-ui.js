function escape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function size(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(value / 1_000_000)} MB`;
}

export function renderArchiveState(status) {
  if (!status) return '<p class="metric-empty">Archive status unavailable.</p>';
  return `<p class="metric-empty">Archive execution: ${status.configured ? 'enabled' : 'disabled'}. Raw-data pruning: ${status.pruningEnabled ? 'enabled' : 'disabled'}.</p>`;
}

export function renderOperationsStatus(status) {
  const current = status?.current;
  if (!current) return '<p class="metric-empty">Capacity history will appear after the first operational snapshot.</p>';
  const oldest = status.history?.at(-1);
  const growth = oldest && oldest.civilDate !== current.civilDate
    ? current.databaseBytes - oldest.databaseBytes : null;
  const heading = status.state === 'critical' ? 'Disk critical'
    : status.state === 'warning' ? 'Disk warning' : 'Capacity healthy';
  const detail = status.state === 'ok'
    ? `Disk use is below the ${status.thresholds.warningPercent}% warning threshold.`
    : `${current.filesystemUsedPercent}% of the server filesystem is in use.`;
  return `
    <div class="operations-heading" data-state="${escape(status.state)}"><strong>${heading}</strong><span>${escape(detail)}</span></div>
    <dl class="summary-facts operations-facts">
      <div><dt>Server disk used</dt><dd>${current.filesystemUsedPercent}%</dd></div>
      <div><dt>Disk available</dt><dd>${size(current.filesystemAvailableBytes)}</dd></div>
      <div><dt>Health database</dt><dd>${size(current.databaseBytes)}</dd></div>
      <div><dt>Database change</dt><dd>${growth === null ? 'Building history' : `${growth >= 0 ? '+' : '−'}${size(Math.abs(growth))}`}</dd></div>
      <div><dt>Heart samples</dt><dd>${size(current.relations.heartRateSamplesBytes)}</dd></div>
      <div><dt>Oxygen samples</dt><dd>${size(current.relations.oxygenSaturationSamplesBytes)}</dd></div>
    </dl>
    <p class="metric-empty">Captured ${escape(new Date(current.capturedAt).toLocaleString())}. Database backups are managed by Coolify and private R2 storage; backup failures are reviewed in Coolify until an external notification channel is configured.</p>
  `;
}
