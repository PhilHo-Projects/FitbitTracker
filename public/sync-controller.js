import { syncPresentation, syncRetryDelay } from './settings-ui.js';

// Owns sync state independently of the workspace. Navigation and visibility
// checks share one in-flight request; transient failures never unlock a job.
export function createSyncController({
  request, onChange, onComplete = () => {}, onError = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, timeoutMs = 15_000,
}) {
  let presentation = { active: true, phase: 'checking', jobId: null, label: 'Checking sync status' };
  let trackedJobId = null;
  let wasActive = false;
  let failures = 0;
  let timer;
  let operation;
  onChange(presentation);

  function publish(value) {
    presentation = value;
    onChange(value);
  }

  async function boundedRequest(url, options = {}) {
    const controller = new AbortController();
    let deadline;
    try {
      return await Promise.race([
        request(url, { ...options, signal: controller.signal }),
        new Promise((_, reject) => {
          deadline = setTimer(() => {
            controller.abort();
            reject(new Error('Sync request timed out'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimer(deadline);
    }
  }

  async function poll() {
    clearTimer(timer);
    let next;
    try {
      next = syncPresentation(await boundedRequest('/api/sync/status'), trackedJobId);
      failures = 0;
    } catch {
      failures++;
      publish({ ...presentation, active: true, phase: 'unavailable', label: 'Sync status temporarily unavailable' });
      timer = setTimer(refresh, syncRetryDelay(failures - 1));
      return;
    }
    const completed = wasActive && ['completed', 'completed_with_errors', 'failed'].includes(next.phase);
    wasActive = next.active;
    trackedJobId = next.active ? next.jobId : null;
    publish(next);
    timer = setTimer(refresh, next.active ? 5000 : 60_000);
    if (completed) {
      // A workspace load failure is not a sync failure. Never re-run completion
      // just because loading the newly synchronized data failed.
      try { await onComplete(next); } catch (error) { onError(error); }
    }
  }

  function refresh() {
    if (!operation) operation = poll().finally(() => { operation = null; });
    return operation;
  }

  function start() {
    if (operation) return operation;
    if (presentation.active) return refresh();
    clearTimer(timer);
    publish({ active: true, phase: 'queued', jobId: null, label: 'Sync queued' });
    operation = (async () => {
      try {
        const job = await boundedRequest('/api/sync', { method: 'POST', body: JSON.stringify({ mode: 'recent' }) });
        trackedJobId = job.id;
        wasActive = true;
      } catch (error) {
        onError(error);
      }
      // The POST may have succeeded even when its response was lost.
      await poll();
    })().finally(() => { operation = null; });
    return operation;
  }

  return { refresh, start };
}
