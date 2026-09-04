import assert from 'node:assert/strict';
import test from 'node:test';

import * as inspectorModule from '../lib/db/inspector-repository.js';

test('source redaction preserves measurements while removing identifiers, secrets, and user paths', () => {
  const source = {
    dataPointName: 'accounts/private-user/dataPoints/private-point',
    providerId: 'provider-private-id',
    heartRate: {
      samples: [{ sampleTime: '2026-07-16T12:00:00Z', beatsPerMinute: 72 }],
    },
    dataSource: {
      device: {
        manufacturer: 'Google',
        displayName: 'Pixel Watch',
        formFactor: 'FORM_FACTOR_WATCH',
      },
      application: {
        packageName: 'com.google.android.apps.fitness',
        webClientId: 'private-oauth-client-id',
      },
    },
    authorization: 'Bearer private-access-token',
    nested: {
      refreshToken: 'private-refresh-token',
      filePath: 'C:\\Users\\private-user\\health.json',
    },
  };
  const before = structuredClone(source);

  const redacted = inspectorModule.redactSourceJson?.(source);

  assert.deepEqual(source, before);
  assert.equal(redacted?.dataPointName, '[redacted]');
  assert.equal(redacted?.providerId, '[redacted]');
  assert.equal(redacted?.authorization, '[redacted]');
  assert.equal(redacted?.nested.refreshToken, '[redacted]');
  assert.equal(redacted?.nested.filePath, '[redacted]');
  assert.equal(redacted?.dataSource.application.webClientId, '[redacted]');
  assert.equal(redacted?.dataSource.device.displayName, 'Pixel Watch');
  assert.equal(redacted?.dataSource.device.formFactor, 'FORM_FACTOR_WATCH');
  assert.equal(redacted?.heartRate.samples[0].beatsPerMinute, 72);
});

test('civil-day coverage follows profile timezone across daylight-saving transitions', () => {
  assert.deepEqual(
    inspectorModule.civilDayWindow('2026-03-08', 'America/Toronto'),
    {
      startTime: '2026-03-08T05:00:00.000Z',
      endTime: '2026-03-09T04:00:00.000Z',
      civilDaySeconds: 82800,
    },
  );
  assert.deepEqual(
    inspectorModule.civilDayWindow('2026-11-01', 'America/Toronto'),
    {
      startTime: '2026-11-01T04:00:00.000Z',
      endTime: '2026-11-02T05:00:00.000Z',
      civilDaySeconds: 90000,
    },
  );
});

test('interval coverage merges overlaps and reports exact missing windows', () => {
  const coverage = inspectorModule.intervalCoverage(
    [
      {
        startTime: '2026-07-16T04:00:00.000Z',
        endTime: '2026-07-16T06:00:00.000Z',
      },
      {
        startTime: '2026-07-16T05:30:00.000Z',
        endTime: '2026-07-16T07:00:00.000Z',
      },
      {
        startTime: '2026-07-17T03:00:00.000Z',
        endTime: '2026-07-17T05:00:00.000Z',
      },
    ],
    inspectorModule.civilDayWindow('2026-07-16', 'America/Toronto'),
  );

  assert.equal(coverage.coverageSeconds, 14400);
  assert.equal(coverage.gapSeconds, 72000);
  assert.deepEqual(coverage.gaps, [
    {
      startTime: '2026-07-16T07:00:00.000Z',
      endTime: '2026-07-17T03:00:00.000Z',
      durationSeconds: 72000,
    },
  ]);
});
