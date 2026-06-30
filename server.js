import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL || 'https://n8n.philippeho.dev/webhook/fitness-sync';
const N8N_WEBHOOK_TOKEN = process.env.N8N_WEBHOOK_TOKEN || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Liveness probe (used by Coolify health checks)
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'fitbit-tracker', ts: new Date().toISOString() });
});

// Tells the browser where the data comes from, without leaking the token.
app.get('/api/config', (_req, res) => {
  res.json({ webhookConfigured: Boolean(N8N_WEBHOOK_URL), tokenSet: Boolean(N8N_WEBHOOK_TOKEN) });
});

// Server-side proxy to the n8n webhook. Keeps the shared token off the browser
// and sidesteps CORS. Returns whatever JSON n8n produced, or a clean error.
app.post('/api/fitness', async (_req, res) => {
  const started = Date.now();
  try {
    const upstream = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-fitness-token': N8N_WEBHOOK_TOKEN,
      },
      body: JSON.stringify({
        source: 'fitbit-tracker-dashboard',
        requestedAt: new Date().toISOString(),
      }),
    });

    const bodyText = await upstream.text();
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = { raw: bodyText };
    }

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        stage: 'n8n-webhook',
        status: upstream.status,
        message: `n8n webhook returned HTTP ${upstream.status}`,
        hint:
          upstream.status === 404
            ? 'Workflow not found or not active. Import fitness-workflow.json and toggle it Active in n8n.'
            : 'Check the n8n execution log for this webhook.',
        data,
        elapsedMs: Date.now() - started,
      });
    }

    return res.json({ ok: true, elapsedMs: Date.now() - started, data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      stage: 'proxy',
      message: err?.message || String(err),
      hint: 'Could not reach the n8n webhook. Check N8N_WEBHOOK_URL and that the workflow is active.',
      elapsedMs: Date.now() - started,
    });
  }
});

app.listen(PORT, () => {
  console.log(`FitbitTracker dashboard listening on http://localhost:${PORT}`);
  console.log(`Proxying sync requests to: ${N8N_WEBHOOK_URL}`);
});
