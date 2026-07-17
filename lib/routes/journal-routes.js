import express from 'express';

function tomorrow(date) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function handler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function createJournalRouter({ repository, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    '/',
    handler(async (req, res) => {
      const startDate = req.query.start || new Date().toISOString().slice(0, 10);
      const endDateExclusive = req.query.end || tomorrow(startDate);
      res.json({
        ok: true,
        data: await repository.list({ startDate, endDateExclusive }),
      });
    }),
  );

  router.post(
    '/',
    handler(async (req, res) => {
      const entry = await repository.create({
        civilDate: req.body?.civilDate,
        occurredAt: req.body?.occurredAt || new Date().toISOString(),
        body: req.body?.body,
        tags: req.body?.tags,
      });
      res.status(201).json({ ok: true, data: entry });
    }),
  );

  router.put(
    '/:id',
    handler(async (req, res) => {
      const entry = await repository.update(req.params.id, {
        body: req.body?.body,
        tags: req.body?.tags,
      });
      res.json({ ok: true, data: entry });
    }),
  );

  router.delete(
    '/:id',
    handler(async (req, res) => {
      res.json({ ok: true, data: await repository.remove(req.params.id) });
    }),
  );

  return router;
}
