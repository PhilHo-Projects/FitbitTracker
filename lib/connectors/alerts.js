export function createConnectorAlerter({ url, token, publicOrigin, fetchImpl = globalThis.fetch, logger = console, timeoutMs = 10_000 }) {
  return {
    async notifyDisconnected(message) {
      if (!url || !token) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const origin = String(publicOrigin || '').split(',')[0].trim().replace(/\/$/, '');
        const reason = String(message).includes('invalid_grant') ? 'invalid_grant' : 'authorization unavailable';
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fitness-token': token },
          body: JSON.stringify({
            source: 'health-hub-connector', severity: 'warning',
            text: `Google Health disconnected: ${reason}. Reconnect to resume syncing.`,
            reconnectUrl: `${origin}/settings`, occurredAt: new Date().toISOString(),
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Webhook rejected notification');
      } catch {
        try { logger.error('Connector alert could not be delivered'); } catch { /* Best effort. */ }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
