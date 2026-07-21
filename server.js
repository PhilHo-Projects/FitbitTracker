import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArchiveConfig } from './lib/archive/config.js';
import { createHealthArchiveRepository } from './lib/archive/repository.js';
import { createArchiveObjectStore, createS3ClientFromConfig } from './lib/archive/s3.js';
import { createHealthArchiveService } from './lib/archive/service.js';
import { createHealthArchiveWorker } from './lib/archive/worker.js';
import { createHealthRepository } from './lib/db/health-repository.js';
import { createMetricWriter } from './lib/db/metric-writer.js';
import { createPool, databaseReady } from './lib/db/pool.js';
import { createAnalysisDatasetService } from './lib/exports/dataset.js';
import { createExportService } from './lib/exports/service.js';
import { securityHeaders, validateMutationOrigin, createLoginThrottle } from './lib/http/security.js';
import { createJournalCipher } from './lib/journal/crypto.js';
import { createJournalRepository } from './lib/journal/repository.js';
import { createGoogleHealthGateway } from './lib/jobs/google-health-gateway.js';
import { createSyncRepository } from './lib/jobs/sync-repository.js';
import { createSyncService } from './lib/jobs/sync-service.js';
import { createExportRouter } from './lib/routes/export-routes.js';
import { createHealthRouter } from './lib/routes/health-routes.js';
import { createJournalRouter } from './lib/routes/journal-routes.js';
import { createSyncRouter } from './lib/routes/sync-routes.js';
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

function dateOffset(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createApp(options = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    readinessCheck,
    syncService = null,
    exportService = null,
  } = options;
  const pool = options.pool === undefined ? createPool(env) : options.pool;
  const healthRepository =
    options.healthRepository ?? (pool
      ? createHealthRepository(pool, {
          archiveConfigured: env.HEALTH_ARCHIVE_ENABLED === 'true',
          archivePruningEnabled: env.HEALTH_ARCHIVE_PRUNING_ENABLED === 'true',
          retentionDays: positiveNumber(env.RAW_RETENTION_DAYS, 90),
          now,
        })
      : null);
  let journalRepository = options.journalRepository ?? null;
  if (!journalRepository && pool && env.JOURNAL_ENCRYPTION_KEYS) {
    journalRepository = createJournalRepository(
      pool,
      createJournalCipher(env.JOURNAL_ENCRYPTION_KEYS),
    );
  }

  const app = express();
  const publicDir = path.join(__dirname, 'public');
  const webhookUrl = env.N8N_WEBHOOK_URL || '';
  const webhookToken = env.N8N_WEBHOOK_TOKEN || '';
  const dashboardPassword = env.DASHBOARD_PASSWORD || '';
  const sessionSecret = env.DASHBOARD_SESSION_SECRET || '';
  const secureCookie = env.NODE_ENV === 'production';
  const loginThrottle = createLoginThrottle({ now });

  app.disable('x-powered-by');
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(validateMutationOrigin);

  const hasAuthConfig = () => Boolean(dashboardPassword && sessionSecret);
  const isAuthenticated = (req) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    return hasAuthConfig() && verifySessionToken(token, sessionSecret, now());
  };
  const requireAuth = (req, res, next) => {
    if (isAuthenticated(req)) return next();
    if (req.originalUrl.startsWith('/api/') || req.baseUrl.startsWith('/api')) {
      return res.status(401).json({ ok: false, message: 'Authentication required' });
    }
    return res.redirect('/login');
  };

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'personal-health-data-hub', ts: new Date(now()).toISOString() });
  });
  app.get('/readyz', async (_req, res) => {
    const ready = readinessCheck ? await readinessCheck() : await databaseReady(pool);
    res.status(ready ? 200 : 503).json({ ok: ready, ready });
  });

  app.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/');
    return res.sendFile(path.join(publicDir, 'login.html'));
  });

  app.post('/api/login', loginThrottle.middleware, (req, res) => {
    if (!hasAuthConfig()) {
      return res.status(503).json({ ok: false, message: 'Dashboard authentication is not configured' });
    }
    if (!constantTimeEqual(req.body?.password ?? '', dashboardPassword)) {
      loginThrottle.failed(req.loginThrottleKey);
      return res.status(401).json({ ok: false, message: 'Invalid password' });
    }
    loginThrottle.succeeded(req.loginThrottleKey);
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
      databaseConfigured: Boolean(pool),
      journalConfigured: Boolean(journalRepository),
      exportsConfigured: Boolean(exportService),
    });
  });

  if (healthRepository) {
    app.use('/api', createHealthRouter({ repository: healthRepository, requireAuth }));
  }
  if (journalRepository) {
    app.use('/api/journal', createJournalRouter({ repository: journalRepository, requireAuth }));
  } else {
    app.use('/api/journal', requireAuth, (_req, res) => {
      res.status(503).json({ ok: false, message: 'Journal encryption is not configured' });
    });
  }
  if (syncService) {
    app.use('/api/sync', createSyncRouter({ service: syncService, requireAuth }));
  } else {
    app.use('/api/sync', requireAuth, (_req, res) => {
      res.status(503).json({ ok: false, message: 'Synchronization worker is not configured' });
    });
  }
  if (exportService) {
    app.use('/api/exports', createExportRouter({ service: exportService, requireAuth }));
  } else {
    app.use('/api/exports', requireAuth, (_req, res) => {
      res.status(503).json({ ok: false, message: 'Export worker is not configured' });
    });
  }

  app.post(['/api/sleep', '/api/fitness'], requireAuth, async (_req, res, next) => {
    const started = now();
    try {
      if (healthRepository) {
        const date = new Date(now()).toISOString().slice(0, 10);
        if (_req.path === '/api/sleep') {
          const data = await healthRepository.getSleepRange(dateOffset(date, -6), dateOffset(date, 1));
          return res.json({
            ok: true,
            elapsedMs: now() - started,
            data: {
              latest: data.sessions[0] ?? null,
              nights: data.sessions,
              naps: [],
              summary: { nightsCount: data.sessions.length },
              range: {
                startDate: dateOffset(date, -6),
                endDateExclusive: dateOffset(date, 1),
              },
            },
          });
        }
        return res.json({ ok: true, elapsedMs: now() - started, data: await healthRepository.getDashboard(date) });
      }

      const upstream = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fitness-token': webhookToken },
        body: JSON.stringify({
          source: 'fitbit-tracker-dashboard',
          requestedAt: new Date(now()).toISOString(),
        }),
      });
      const data = parseUpstreamBody(await upstream.text());
      if (!upstream.ok) {
        return res.status(502).json({
          ok: false,
          stage: 'n8n-webhook',
          status: upstream.status,
          message: `n8n webhook returned HTTP ${upstream.status}`,
          data,
          elapsedMs: now() - started,
        });
      }
      return res.json({ ok: true, elapsedMs: now() - started, data });
    } catch (error) {
      return next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    const status = Number(error.status) || (error.message?.includes('not found') ? 404 : 500);
    if (status >= 500) console.error('Request failed', { message: error.message });
    res.status(status).json({
      ok: false,
      message: status >= 500 ? 'The request could not be completed' : error.message,
    });
  });

  return app;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const port = process.env.PORT || 3000;
  const pool = createPool();
  const journalRepository =
    pool && process.env.JOURNAL_ENCRYPTION_KEYS
      ? createJournalRepository(pool, createJournalCipher(process.env.JOURNAL_ENCRYPTION_KEYS))
      : null;
  const syncService =
    pool && process.env.N8N_WEBHOOK_URL && process.env.N8N_WEBHOOK_TOKEN
      ? createSyncService({
          pool,
          repository: createSyncRepository(pool),
          gateway: createGoogleHealthGateway({
            url: process.env.N8N_WEBHOOK_URL,
            token: process.env.N8N_WEBHOOK_TOKEN,
          }),
          writer: createMetricWriter(pool, {
            compactWritesEnabled: process.env.HEALTH_COMPACT_WRITES_ENABLED === 'true',
          }),
          rawRetentionDays: positiveNumber(process.env.RAW_RETENTION_DAYS, null),
        })
      : null;
  const exportService = pool
    ? createExportService({
        pool,
        datasetService: createAnalysisDatasetService({
          pool,
          journalRepository,
          availabilityOptions: {
            archiveConfigured: process.env.HEALTH_ARCHIVE_ENABLED === 'true',
            archivePruningEnabled: process.env.HEALTH_ARCHIVE_PRUNING_ENABLED === 'true',
            retentionDays: positiveNumber(process.env.RAW_RETENTION_DAYS, 90),
          },
        }),
        storageDirectory:
          process.env.EXPORT_STORAGE_DIR || path.join(__dirname, '.runtime', 'exports'),
        })
      : null;
  let archiveWorker = null;
  let archiveObjectClient = null;
  try {
    const archiveConfig = parseArchiveConfig(process.env);
    if (pool && archiveConfig.enabled) {
      const archiveRepository = createHealthArchiveRepository(pool);
      archiveObjectClient = createS3ClientFromConfig(archiveConfig);
      const archiveObjectStore = createArchiveObjectStore({
        client: archiveObjectClient,
        bucket: archiveConfig.bucket,
      });
      archiveWorker = createHealthArchiveWorker({
        enabled: true,
        repository: archiveRepository,
        intervalMs:
          positiveNumber(process.env.HEALTH_ARCHIVE_INTERVAL_HOURS, 24) * 60 * 60 * 1000,
        serviceFactory: () => createHealthArchiveService({
          pool,
          repository: archiveRepository,
          objectStore: archiveObjectStore,
          config: archiveConfig,
          batchSize: positiveNumber(process.env.HEALTH_ARCHIVE_BATCH_SIZE, 1000),
          temporaryRoot:
            process.env.HEALTH_ARCHIVE_TEMP_DIR
            || path.join(__dirname, '.runtime', 'health-archive'),
        }),
        onError: (error) => console.error(error.message),
      });
    }
  } catch {
    // Archive configuration and storage are intentionally isolated from readiness and sync.
    console.error('Health archive worker is disabled because initialization failed');
    archiveObjectClient?.destroy();
    archiveObjectClient = null;
  }
  const app = createApp({ pool, syncService, journalRepository, exportService });
  const server = app.listen(port, () => {
    console.log(`Personal Health Data Hub listening on http://localhost:${port}`);
  });
  syncService?.start({
    scheduleEnabled: process.env.SYNC_SCHEDULE_ENABLED !== 'false',
    syncIntervalMs:
      positiveNumber(process.env.SYNC_INTERVAL_HOURS, 3) * 60 * 60 * 1000,
    scheduledLookbackDays: positiveNumber(process.env.SYNC_SCHEDULE_LOOKBACK_DAYS, 7),
  });
  exportService?.start();
  archiveWorker?.start();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      syncService?.stop();
      exportService?.stop();
      archiveWorker?.stop();
      archiveObjectClient?.destroy();
      server.close();
      await pool?.end();
      process.exit(0);
    });
  }
}
