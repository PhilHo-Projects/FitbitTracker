import express from 'express';

export function createOperationsRouter({ service, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/status', async (_req, res, next) => {
    try {
      res.json({ ok: true, data: await service.status() });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

