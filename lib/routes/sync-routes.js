import express from 'express';

function handler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function createSyncRouter({ service, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);

  router.post(
    '/',
    handler(async (req, res) => {
      const job = await service.enqueue({
        requestedBy: 'user',
        startDate: req.body?.startDate,
        endDateExclusive: req.body?.endDateExclusive,
        metrics: req.body?.metrics,
        mode: req.body?.mode || 'recent',
      });
      res.status(202).json({ ok: true, data: job });
    }),
  );
  router.get(
    '/status',
    handler(async (_req, res) => {
      res.json({ ok: true, data: await service.status() });
    }),
  );

  return router;
}
