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
  button.textContent = status.connected ? 'Reconnect' : 'Connect Google Health';
  button.disabled = status.configured === false;
  if (status.configured === false) detail.textContent = 'The owned connector is not configured on this server.';
  const mode = document.getElementById('connectorMode');
  if (mode) mode.textContent = status.mode === 'direct' ? 'Owned Google connector' : 'n8n (legacy sync path)';
  const lastSync = document.getElementById('connectorLastSync');
  if (lastSync) lastSync.textContent = status.lastSuccessfulSync ? new Date(status.lastSuccessfulSync).toLocaleString() : 'Never';

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
  if (params.get('connected') === '1') return 'Google Health connected.';
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
