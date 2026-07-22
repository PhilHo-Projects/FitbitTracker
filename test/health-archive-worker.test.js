import assert from 'node:assert/strict';
import test from 'node:test';

import { createHealthArchiveWorker } from '../lib/archive/worker.js';

test('disabled archive worker creates no service, timer, or network work', async () => {
  let services = 0;
  let timers = 0;
  const worker = createHealthArchiveWorker({
    enabled: false,
    serviceFactory() { services += 1; return {}; },
    repository: { async listEligibleMonths() { throw new Error('must not query'); } },
    setIntervalImpl() { timers += 1; },
  });

  assert.deepEqual(await worker.runOnce(), { enabled: false, processed: 0, failures: 0 });
  worker.start();
  assert.equal(services, 0);
  assert.equal(timers, 0);
});

test('archive worker is independent, serial, and contains individual month failures', async () => {
  const calls = [];
  const errors = [];
  const worker = createHealthArchiveWorker({
    enabled: true,
    repository: {
      async listEligibleMonths() {
        return [
          { source_account_id: 'account-1', archive_month: '2026-01-01' },
          { source_account_id: 'account-2', archive_month: '2026-02-01' },
        ];
      },
    },
    serviceFactory() {
      return {
        async archiveMonth(options) {
          calls.push(options);
          if (options.sourceAccountId === 'account-1') throw new Error('R2 unavailable secret');
        },
      };
    },
    onError(error) { errors.push(error.message); },
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, { enabled: true, processed: 1, failures: 1 });
  assert.deepEqual(calls, [
    { sourceAccountId: 'account-1', archiveMonth: '2026-01-01' },
    { sourceAccountId: 'account-2', archiveMonth: '2026-02-01' },
  ]);
  assert.deepEqual(errors, ['Health archive worker month failed']);
});
