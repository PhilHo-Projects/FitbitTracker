const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export function connectorBannerMessage(status, { newestMeasurementAt, now = Date.now() } = {}) {
  if (!status) return 'Google Health connection status is unavailable. Check Settings.';
  if (status.configured !== false && status.connected !== true) {
    return 'Google Health is disconnected. Open Settings to reconnect — this takes about twenty seconds.';
  }
  if (!newestMeasurementAt) {
    return 'No health measurements have synced yet. Check Settings.';
  }
  const age = now - Date.parse(newestMeasurementAt);
  if (!Number.isFinite(age)) return 'Health data freshness is unavailable. Check Settings.';
  if (age <= STALE_AFTER_MS) return null;
  const days = Math.floor(age / 86_400_000);
  const detail = days >= 1 ? `${days} days` : `${Math.floor(age / 3_600_000)} hours`;
  return `The newest health data is ${detail} old. Check Settings for the connection state.`;
}

export function renderConnectorStatus(document, status) {
  const state = document.getElementById('connectorState');
  const detail = document.getElementById('connectorDetail');
  const button = document.getElementById('connectorConnect');
  if (!state || !detail || !button) return;
  if (!status) {
    state.textContent = 'Unavailable';
    detail.textContent = 'Could not load connection status. Try again shortly.';
    button.disabled = true;
    const disconnect = document.getElementById('connectorDisconnect');
    if (disconnect) disconnect.hidden = true;
    return;
  }
  state.textContent = status.configured === false ? 'Not configured' : status.connected ? 'Connected' : 'Disconnected';
  state.dataset.state = status.connected ? 'connected' : 'disconnected';
  detail.textContent = status.connected
    ? `${status.email || 'Google account'} · token expires ${
        status.accessTokenExpiresAt
          ? new Date(status.accessTokenExpiresAt).toLocaleString()
          : 'unknown'
      }`
    : status.lastError || 'Not connected';
  button.textContent = 'Reconnect Google Health';
  button.disabled = status.configured === false;
  if (status.configured === false) detail.textContent = 'The owned connector is not configured on this server.';
  const mode = document.getElementById('connectorMode');
  if (mode) mode.textContent = status.mode === 'direct' ? 'Owned Google connector' : 'n8n (legacy sync path)';
  const lastSync = document.getElementById('connectorLastSync');
  if (lastSync) lastSync.textContent = status.lastSuccessfulSync ? new Date(status.lastSuccessfulSync).toLocaleString() : 'Never';
  for (const [id, value] of [['connectorLastFetch', status.lastSuccessfulFetch], ['connectorNewestMeasurement', status.newestMeasurementAt]]) {
    const element = document.getElementById(id);
    if (element) element.textContent = value ? new Date(value).toLocaleString() : 'Never';
  }
  const recovery = document.getElementById('connectorRecovery');
  if (recovery) recovery.textContent = status.mode !== 'direct' ? 'Sync uses the legacy connector.'
    : !status.connected ? 'Sync paused until Google is reconnected. Pending work is retained.'
    : status.recoveryPending ? 'History recovery is pending and will retry automatically.' : 'Scheduled sync is enabled.';

  const connectedAt = document.getElementById('connectorConnectedAt');
  if (connectedAt) {
    connectedAt.textContent = status.connectedAt
      ? new Date(status.connectedAt).toLocaleString()
      : 'Not connected yet';
  }
  const scopes = document.getElementById('connectorScopes');
  if (scopes) {
    scopes.textContent = status.scope
      ? String(status.scope).split(/\s+/).filter(Boolean).map((scope) => scope.replace('https://www.googleapis.com/auth/googlehealth.', '')).join('\n')
      : 'No scopes recorded';
  }
  const disconnect = document.getElementById('connectorDisconnect');
  if (disconnect) disconnect.hidden = !status.connected;
}

export function connectorCallbackMessage(search) {
  const params = new URLSearchParams(search);
  if (params.get('connected') === '1') return params.get('recovery') === 'pending'
    ? 'Google Health connected. History recovery is pending; the worker will retry automatically.'
    : 'Google Health connected.';
  if (!params.has('error')) return null;
  if (params.get('error') === 'access_denied') return 'Google consent was declined. You can try connecting again.';
  if (params.get('error') === 'invalid_state') return 'The connection request expired or did not match this browser. Please try again.';
  return 'Google Health could not connect. Please try again and grant all requested permissions.';
}

export function syncJobOutcome(status, id) {
  const job = [...(status.active || []), ...(status.recent || [])].find((job) => job.id === id);
  if (job?.status === 'completed') return 'completed';
  if (['failed', 'completed_with_errors'].includes(job?.status)) return 'failed';
  return 'pending';
}

const metricLabels = {
  sleep: 'sleep',
  'heart-rate': 'heart rate',
  'daily-resting-heart-rate': 'resting heart rate',
  'active-energy-burned': 'active energy',
  'basal-energy-burned': 'basal energy',
  'oxygen-saturation': 'blood oxygen',
  'daily-oxygen-saturation': 'daily blood oxygen',
  'daily-heart-rate-variability': 'daily HRV',
  'heart-rate-variability': 'HRV',
  'daily-respiratory-rate': 'breathing rate',
  'respiratory-rate-sleep-summary': 'sleep breathing',
  'daily-sleep-temperature-derivations': 'sleep temperature',
};

export function syncPresentation(status = {}, trackedJobId = null) {
  if (status.pausedReason === 'GOOGLE_RECONNECT_REQUIRED') {
    return { jobId: trackedJobId, active: false, phase: 'disconnected', completedChunks: 0, totalChunks: 0, label: 'Reconnect Google Health' };
  }
  const jobs = [...(status.active || []), ...(status.recent || [])];
  const job = (trackedJobId && jobs.find(({ id }) => id === trackedJobId)) || status.active?.[0] || null;
  if (!job) return { jobId: null, active: false, phase: 'idle', completedChunks: 0, totalChunks: 0, label: 'Local archive' };
  if (job.status === 'completed') return { jobId: job.id, active: false, phase: 'completed', completedChunks: 0, totalChunks: 0, label: 'Sync complete' };
  if (['failed', 'completed_with_errors'].includes(job.status)) {
    return { jobId: job.id, active: false, phase: 'failed', completedChunks: 0, totalChunks: 0, label: 'Sync needs attention' };
  }
  const metrics = job.metricsStatus || [];
  const completedChunks = metrics.reduce((sum, metric) => sum + Number(metric.completedChunks || 0), 0);
  const totalChunks = metrics.reduce((sum, metric) => sum + Number(metric.totalChunks || 0), 0);
  const current = metrics.find(({ status }) => status === 'pending')?.metric;
  const detail = totalChunks ? ` · ${completedChunks}/${totalChunks} steps` : '';
  const phase = job.status === 'queued' ? 'queued' : 'running';
  const action = phase === 'queued' ? 'Sync queued' : `Syncing ${metricLabels[current] || current || 'health data'}`;
  return { jobId: job.id, active: true, phase, completedChunks, totalChunks, label: `${action}${detail}` };
}

export function syncRetryDelay(failures = 0) {
  return Math.min(60_000, 5000 * (2 ** Math.max(0, Number(failures) || 0)));
}
