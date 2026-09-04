import express from 'express';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSPECTOR_CATEGORIES = new Set(['sleep', 'heart', 'calories']);

function validDate(value) {
  const text = String(value || '');
  if (!DATE_PATTERN.test(text)) return false;
  const parsed = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
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

function inspectorRequest(req, { defaultLimit, maximumLimit }) {
  const category = req.params.category;
  const date = req.query.date;
  if (!INSPECTOR_CATEGORIES.has(category)) {
    const error = new Error('category must be sleep, heart, or calories');
    error.status = 400;
    throw error;
  }
  if (!validDate(date)) {
    const error = new Error('date must be YYYY-MM-DD');
    error.status = 400;
    throw error;
  }
  const requestedLimit = req.query.limit === undefined ? defaultLimit : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    const error = new Error('limit must be a positive integer');
    error.status = 400;
    throw error;
  }
  return {
    category,
    date,
    options: {
      cursor: req.query.cursor ? String(req.query.cursor) : null,
      limit: Math.min(maximumLimit, requestedLimit),
    },
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

  router.get(
    '/inspector/:category/source',
    handler(async (req, res) => {
      const { category, date, options } = inspectorRequest(req, {
        defaultLimit: 20,
        maximumLimit: 50,
      });
      res.json({
        ok: true,
        data: await repository.getInspectorSource(category, date, options),
      });
    }),
  );

  router.get(
    '/inspector/:category',
    handler(async (req, res) => {
      const { category, date, options } = inspectorRequest(req, {
        defaultLimit: 100,
        maximumLimit: 200,
      });
      res.json({
        ok: true,
        data: await repository.getInspector(category, date, options),
      });
    }),
  );

  router.get(
    '/archive/status',
    handler(async (_req, res) => {
      res.json({ ok: true, data: await repository.getArchiveStatus() });
    }),
  );

  return router;
}
