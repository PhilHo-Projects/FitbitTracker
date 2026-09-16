import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncController } from '../public/sync-controller.js';

function harness(request) {
  const timers = new Map();
  let id = 0;
  const changes = [];
  const completions = [];
  const errors = [];
  const controller = createSyncController({
    request, onChange: value => changes.push(value),
    onComplete: value => completions.push(value), onError: error => errors.push(error),
    setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; },
    clearTimer: key => timers.delete(key), timeoutMs: 100,
  });
  return { controller, changes, completions, errors, timers,
    get current() { return changes.at(-1); },
    fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `expected a ${delay}ms timer`);
      timers.delete(entry[0]);
      return entry[1].fn();
    },
  };
}

const active = status => ({ active: [{ id: 'job', status, metricsStatus: [] }], recent: [] });
const terminal = status => ({ active: [], recent: [{ id: 'job', status, metricsStatus: [] }] });

test('startup locks sync while discovering the server job, including a reload', async () => {
  for (let reload = 0; reload < 2; reload++) {
    const h = harness(async () => active('running'));
    assert.equal(h.current.active, true);
    assert.equal(h.current.phase, 'checking');
    await h.controller.refresh();
    assert.equal(h.current.jobId, 'job');
    assert.equal(h.current.phase, 'running');
    assert.equal(h.completions.length, 0);
  }
});

for (const outcome of ['completed', 'completed_with_errors', 'failed']) {
  test(`queued → running → ${outcome} reloads data only once at the terminal state`, async () => {
    let status = active('queued');
    const h = harness(async () => status);
    await h.controller.refresh();
    assert.equal(h.current.phase, 'queued');
    status = active('running');
    await h.fire(5000);
    assert.equal(h.current.active, true);
    assert.equal(h.completions.length, 0);
    status = terminal(outcome);
    await h.fire(5000);
    assert.equal(h.current.phase, outcome);
    assert.equal(h.current.active, false);
    assert.equal(h.completions.length, 1);
    await h.controller.refresh();
    assert.equal(h.completions.length, 1);
  });
}

test('navigation/visibility refresh adopts jobs started elsewhere and coalesces concurrent requests', async () => {
  let status = { active: [], recent: [] };
  let reads = 0;
  const h = harness(async () => { reads++; return status; });
  await h.controller.refresh();
  assert.equal(h.current.active, false);
  status = active('running');
  await Promise.all([h.controller.refresh(), h.controller.refresh(), h.controller.refresh()]);
  assert.equal(reads, 2);
  assert.equal(h.current.active, true);
});

test('transient failures retain the lock, back off with a bound, and recover', async () => {
  let failure = false;
  const h = harness(async () => { if (failure) throw Error('offline'); return active('running'); });
  await h.controller.refresh();
  failure = true;
  await h.controller.refresh();
  assert.equal(h.current.phase, 'unavailable');
  assert.equal(h.current.active, true);
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) await h.fire(delay);
  failure = false;
  await h.fire(60000);
  assert.equal(h.current.phase, 'running');
  assert.equal(h.current.active, true);
});

test('a hung poll times out, aborts and reconnects without accepting a late response', async () => {
  let resolve;
  let signal;
  let hang = true;
  const h = harness(async (_url, options) => {
    if (!hang) return active('running');
    signal = options.signal;
    return new Promise(done => { resolve = done; });
  });
  const pending = h.controller.refresh();
  h.fire(100);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(h.current.phase, 'unavailable');
  hang = false;
  await h.fire(5000);
  resolve(terminal('completed'));
  await Promise.resolve();
  assert.equal(h.current.phase, 'running');
});

test('a duplicate click adopts the one server job and never submits twice', async () => {
  let posts = 0;
  let status = { active: [], recent: [] };
  const h = harness(async (_url, options) => {
    if (options.method === 'POST') { posts++; status = active('running'); return status.active[0]; }
    return status;
  });
  await h.controller.refresh();
  await Promise.all([h.controller.start(), h.controller.start()]);
  assert.equal(posts, 1);
  assert.equal(h.current.jobId, 'job');
  assert.equal(h.current.active, true);
});

test('a lost enqueue response adopts the accepted job without resubmitting', async () => {
  let status = { active: [], recent: [] };
  const h = harness(async (_url, options) => {
    if (options.method === 'POST') { status = active('queued'); throw Error('lost response'); }
    return status;
  });
  await h.controller.refresh();
  await h.controller.start();
  assert.equal(h.current.phase, 'queued');
  assert.equal(h.current.active, true);
});

test('disconnection is distinct and later visibility refresh detects reconnection', async () => {
  let status = { active: [], recent: [], pausedReason: 'GOOGLE_RECONNECT_REQUIRED' };
  const h = harness(async () => status);
  await h.controller.refresh();
  assert.equal(h.current.phase, 'disconnected');
  status = active('queued');
  await h.controller.refresh();
  assert.equal(h.current.phase, 'queued');
});
