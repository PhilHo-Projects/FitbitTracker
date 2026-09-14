const MESSAGES = {
  GOOGLE_RECONNECT_REQUIRED: 'Reconnect Google Health in Settings to resume syncing.',
  UPSTREAM_PERMISSION_DENIED: 'Google Health denied permission for this measurement.',
  UPSTREAM_RATE_LIMITED: 'Google Health temporarily limited requests.',
  UPSTREAM_UNAVAILABLE: 'The health data provider is temporarily unavailable.',
  UPSTREAM_REQUEST_REJECTED: 'The health data provider rejected this request.',
  PROVIDER_CONTRACT_INVALID: 'The provider returned a record that could not be validated.',
  STORAGE_ERROR: 'The measurement could not be saved to the database.',
};

export function reconnectRequired() {
  return Object.assign(new Error(MESSAGES.GOOGLE_RECONNECT_REQUIRED), {
    code: 'GOOGLE_RECONNECT_REQUIRED', status: 409, transient: false, disconnected: true,
  });
}

// Only stable categories leave the worker; upstream text may contain health data or secrets.
export function classifySyncError(error, phase = 'fetch') {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const database = /^[0-9A-Z]{5}$/.test(error?.code ?? '');
  const code = error?.disconnected || error?.code === 'GOOGLE_RECONNECT_REQUIRED' || status === 401
    ? 'GOOGLE_RECONNECT_REQUIRED'
    : database || phase === 'storage' ? 'STORAGE_ERROR'
      : ['OXYGEN_CONTRACT_INVALID', 'PROVIDER_CONTRACT_INVALID'].includes(error?.code) || phase === 'ingest' ? 'PROVIDER_CONTRACT_INVALID'
        : status === 403 ? 'UPSTREAM_PERMISSION_DENIED'
          : status === 429 ? 'UPSTREAM_RATE_LIMITED'
            : status >= 400 && status < 500 ? 'UPSTREAM_REQUEST_REJECTED' : 'UPSTREAM_UNAVAILABLE';
  const transient = code === 'STORAGE_ERROR'
    ? /^(08|40|53|57)/.test(error?.code ?? '')
    : code === 'PROVIDER_CONTRACT_INVALID' ? error?.transient === true
      : ['UPSTREAM_RATE_LIMITED', 'UPSTREAM_UNAVAILABLE'].includes(code) && error?.transient !== false;
  return Object.assign(new Error(MESSAGES[code]), { code, status, transient,
    disconnected: code === 'GOOGLE_RECONNECT_REQUIRED' });
}
