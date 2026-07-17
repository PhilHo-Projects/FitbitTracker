import express from 'express';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  return DATE_PATTERN.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function rangeFrom(query) {
  const startDate = query.start;
  const endDateExclusive = query.end;
  if (!validDate(startDate) || !validDate(endDateExclusive) || startDate >= endDateExclusive) {
    const error = new Error('start and end must be a valid closed-open date range');
    error.status = 400;
    throw error;
  }
  return { startDate, endDateExclusive };
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

export function createHealthRouter({ repository, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    '/dashboard',
    handler(async (req, res) => {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      if (!validDate(date)) return res.status(400).json({ ok: false, message: 'date must be YYYY-MM-DD' });
      return res.json({ ok: true, data: await repository.getDashboard(date) });
    }),
  );

  router.get(
    '/metrics/sleep',
    handler(async (req, res) => {
      const { startDate, endDateExclusive } = rangeFrom(req.query);
      res.json({ ok: true, data: await repository.getSleepRange(startDate, endDateExclusive) });
    }),
  );

  router.get(
    '/metrics/heart',
    handler(async (req, res) => {
      const { startDate, endDateExclusive } = rangeFrom(req.query);
      const resolution = req.query.resolution === 'five-minute' ? 'five-minute' : 'day';
      res.json({
        ok: true,
        data: await repository.getHeartRange(startDate, endDateExclusive, resolution),
      });
    }),
  );

  router.get(
    '/metrics/calories',
    handler(async (req, res) => {
      const { startDate, endDateExclusive } = rangeFrom(req.query);
      const resolution = req.query.resolution === 'hour' ? 'hour' : 'day';
      res.json({
        ok: true,
        data: await repository.getCaloriesRange(startDate, endDateExclusive, resolution),
      });
    }),
  );

  return router;
}
