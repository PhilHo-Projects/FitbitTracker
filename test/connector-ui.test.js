import assert from 'node:assert/strict';
import test from 'node:test';

import {
  connectorBannerMessage,
  renderConnectorStatus,
  connectorCallbackMessage,
  syncJobOutcome,
  syncPresentation,
  syncRetryDelay,
} from '../public/settings-ui.js';

const NOW = Date.parse('2026-09-04T17:00:00Z');

test('an unconfigured owned connector does not mislabel the n8n connection', () => {
  assert.equal(connectorBannerMessage({ configured: false }, { newestMeasurementAt: '2026-09-04T06:00:00Z', now: NOW }), null);
  assert.match(connectorBannerMessage({ configured: false }, { newestMeasurementAt: '2026-08-01T06:00:00Z', now: NOW }), /34 days/);
});

test('unknown connection status or malformed timestamps are not reported as healthy', () => {
  assert.match(connectorBannerMessage(null), /unavailable/i);
  assert.match(connectorBannerMessage({ connected: true }, { newestMeasurementAt: 'bad' }), /unavailable/i);
});

test('settings render scopes, last sync and unavailable actions safely', () => {
  const elements = Object.fromEntries(['connectorState', 'connectorDetail', 'connectorConnect', 'connectorDisconnect', 'connectorConnectedAt', 'connectorScopes', 'connectorLastSync', 'connectorMode'].map((id) => [id, { dataset: {} }]));
  const document = { getElementById: (id) => elements[id] };
  renderConnectorStatus(document, { configured: false });
  assert.equal(elements.connectorConnect.disabled, true);
  assert.equal(elements.connectorDisconnect.hidden, true);
  assert.equal(elements.connectorState.textContent, 'Not configured');
  renderConnectorStatus(document, { configured: true, connected: true, mode: 'direct', scope: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly', lastSuccessfulSync: new Date(NOW).toISOString() });
  assert.equal(elements.connectorConnect.disabled, false);
  assert.equal(elements.connectorScopes.textContent, 'sleep.readonly');
  assert.notEqual(elements.connectorLastSync.textContent, 'Never');
});

test('callback feedback uses only known messages', () => {
  assert.match(connectorCallbackMessage('?connected=1'), /connected/i);
  assert.match(connectorCallbackMessage('?error=access_denied'), /declined/i);
  assert.ok(!connectorCallbackMessage('?error=secret-token').includes('secret-token'));
});

test('sync monitoring waits for completion, including completed-with-errors', () => {
  assert.equal(syncJobOutcome({ active: [{ id: 'a', status: 'running' }], recent: [] }, 'a'), 'pending');
  assert.equal(syncJobOutcome({ recent: [{ id: 'a', status: 'completed' }] }, 'a'), 'completed');
  assert.equal(syncJobOutcome({ recent: [{ id: 'a', status: 'completed_with_errors' }] }, 'a'), 'failed');
  assert.equal(syncJobOutcome({ recent: [] }, 'a'), 'pending');
});

test('sync presentation adopts active work and reports aggregate stream progress', () => {
  const status = {
    active: [{
      id: 'active-1', status: 'running', metricsStatus: [
        { metric: 'sleep', status: 'completed', completedChunks: 2, totalChunks: 2 },
        { metric: 'heart-rate', status: 'pending', completedChunks: 1, totalChunks: 4 },
      ],
    }],
    recent: [],
  };
  assert.deepEqual(syncPresentation(status), {
    jobId: 'active-1', active: true, phase: 'running', completedChunks: 3, totalChunks: 6,
    label: 'Syncing heart rate · 3/6 steps',
  });
  assert.equal(syncPresentation({ ...status, pausedReason: 'GOOGLE_RECONNECT_REQUIRED' }).phase, 'disconnected');
});

test('sync presentation distinguishes terminal outcomes and polling backoff is bounded', () => {
  const completed = { active: [], recent: [{ id: 'done', status: 'completed', metricsStatus: [] }] };
  const partial = { active: [], recent: [{ id: 'partial', status: 'completed_with_errors', metricsStatus: [] }] };
  assert.equal(syncPresentation(completed, 'done').phase, 'completed');
  assert.equal(syncPresentation(partial, 'partial').phase, 'failed');
  assert.equal(syncRetryDelay(0), 5000);
  assert.equal(syncRetryDelay(2), 20000);
  assert.equal(syncRetryDelay(99), 60000);
});

test('no banner when connected and data is fresh', () => {
  assert.equal(
    connectorBannerMessage(
      { connected: true },
      { newestMeasurementAt: '2026-09-04T06:00:00Z', now: NOW },
    ),
    null,
  );
});

test('banner when disconnected', () => {
  const message = connectorBannerMessage(
    { connected: false, lastError: 'invalid_grant' },
    { newestMeasurementAt: '2026-09-04T06:00:00Z', now: NOW },
  );
  assert.match(message, /reconnect/i);
});

test('banner when data is stale despite a live connection', () => {
  const message = connectorBannerMessage(
    { connected: true },
    { newestMeasurementAt: '2026-08-01T06:00:00Z', now: NOW },
  );
  assert.match(message, /34 days/);
});

test('banner when nothing has ever synced', () => {
  assert.ok(
    connectorBannerMessage({ connected: true }, { newestMeasurementAt: null, now: NOW }),
  );
});

test('36 hours is the staleness boundary', () => {
  const fresh = new Date(NOW - 35 * 60 * 60 * 1000).toISOString();
  const stale = new Date(NOW - 37 * 60 * 60 * 1000).toISOString();
  assert.equal(connectorBannerMessage({ connected: true }, { newestMeasurementAt: fresh, now: NOW }), null);
  assert.ok(connectorBannerMessage({ connected: true }, { newestMeasurementAt: stale, now: NOW }));
});
