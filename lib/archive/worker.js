function archiveMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Archive candidate month was not returned as canonical text');
  }
  return value;
}
export function createHealthArchiveWorker({
  enabled = false,
  repository,
  serviceFactory,
  intervalMs = 24 * 60 * 60 * 1000,
  now = () => new Date(),
  onError = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let service;
  let timer;
  let running;

  async function execute() {
    if (!enabled) return { enabled: false, processed: 0, failures: 0 };
    service ??= serviceFactory();
    const candidates = await repository.listEligibleMonths({
      today: now().toISOString().slice(0, 10),
      retentionDays: 90,
    });
    let processed = 0;
    let failures = 0;
    for (const candidate of candidates) {
      try {
        await service.archiveMonth({
          sourceAccountId: candidate.source_account_id,
          archiveMonth: archiveMonth(candidate.archive_month),
        });
        processed += 1;
      } catch (cause) {
        failures += 1;
        onError(new Error('Health archive worker month failed', { cause }));
      }
    }
    return { enabled: true, processed, failures };
  }

  function runOnce() {
    if (running) return running;
    running = execute().finally(() => { running = null; });
    return running;
  }

  return {
    runOnce,
    start() {
      if (!enabled || timer) return;
      void runOnce().catch((cause) => onError(new Error('Health archive worker run failed', { cause })));
      timer = setIntervalImpl(() => {
        void runOnce().catch((cause) => onError(new Error('Health archive worker run failed', { cause })));
      }, intervalMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) clearIntervalImpl(timer);
      timer = null;
    },
  };
}
