import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSessionToken, readCookie, verifySessionToken } from './lib/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'fitbit_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function constantTimeEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left)).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function parseUpstreamBody(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return { raw: bodyText };
  }
}

export function createApp({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const app = express();
  const publicDir = path.join(__dirname, 'public');
  const webhookUrl =
    env.N8N_WEBHOOK_URL || 'https://n8n.philippeho.dev/webhook/fitness-sync';
  const webhookToken = env.N8N_WEBHOOK_TOKEN || '';
  const dashboardPassword = env.DASHBOARD_PASSWORD || '';
  const sessionSecret = env.DASHBOARD_SESSION_SECRET || '';
  const secureCookie = env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  const hasAuthConfig = () => Boolean(dashboardPassword && sessionSecret);
  const isAuthenticated = (req) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    return hasAuthConfig() && verifySessionToken(token, sessionSecret, now());
  };
  const requireAuth = (req, res, next) => {
    if (isAuthenticated(req)) {
      return next();
    }

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, message: 'Authentication required' });
    }

    return res.redirect('/login');
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'fitbit-tracker', ts: new Date(now()).toISOString() });
  });

  app.get('/login', (req, res) => {
    if (isAuthenticated(req)) {
      return res.redirect('/');
    }
    return res.sendFile(path.join(publicDir, 'login.html'));
  });

  app.post('/api/login', (req, res) => {
    if (!hasAuthConfig()) {
      return res.status(503).json({
        ok: false,
        message: 'Dashboard authentication is not configured',
      });
    }

    if (!constantTimeEqual(req.body?.password ?? '', dashboardPassword)) {
      return res.status(401).json({ ok: false, message: 'Invalid password' });
    }

    const token = createSessionToken(sessionSecret, now(), SESSION_TTL_MS);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    return res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie,
      path: '/',
    });
    return res.json({ ok: true });
  });

  app.get(['/', '/index.html'], requireAuth, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(express.static(publicDir, { index: false, maxAge: 0 }));

  app.get('/api/session', requireAuth, (_req, res) => {
    res.json({ ok: true, authenticated: true });
  });

  app.get('/api/config', requireAuth, (_req, res) => {
    res.json({
      webhookConfigured: Boolean(webhookUrl),
      tokenSet: Boolean(webhookToken),
      authenticationConfigured: hasAuthConfig(),
    });
  });

  app.post(['/api/sleep', '/api/fitness'], requireAuth, async (_req, res) => {
    const started = now();

    if (!webhookUrl) {
      return res.status(503).json({
        ok: false,
        stage: 'configuration',
        message: 'N8N_WEBHOOK_URL is not configured',
        elapsedMs: now() - started,
      });
    }

    try {
      const upstream = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fitness-token': webhookToken,
        },
        body: JSON.stringify({
          source: 'fitbit-tracker-dashboard',
          requestedAt: new Date(now()).toISOString(),
        }),
      });

      const bodyText = await upstream.text();
      const data = parseUpstreamBody(bodyText);

      if (!upstream.ok) {
        return res.status(502).json({
          ok: false,
          stage: 'n8n-webhook',
          status: upstream.status,
          message: `n8n webhook returned HTTP ${upstream.status}`,
          hint:
            upstream.status === 404
              ? 'The n8n workflow is missing or inactive.'
              : 'Check the latest n8n execution for the upstream error.',
          data,
          elapsedMs: now() - started,
        });
      }

      return res.json({ ok: true, elapsedMs: now() - started, data });
    } catch (error) {
      return res.status(502).json({
        ok: false,
        stage: 'proxy',
        message: error?.message || String(error),
        hint: 'Could not reach the configured n8n webhook.',
        elapsedMs: now() - started,
      });
    }
  });

  return app;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const port = process.env.PORT || 3000;
  const app = createApp();
  app.listen(port, () => {
    console.log(`FitbitTracker dashboard listening on http://localhost:${port}`);
  });
}
