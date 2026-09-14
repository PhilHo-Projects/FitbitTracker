import express from "express";

export function createSleepRouter({ service, checkIns, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  const handle = (fn) => async (req, res, next) => {
    try {
      res.json({ ok: true, data: await fn(req) });
    } catch (error) {
      next(error);
    }
  };
  function sources(req) {
    try {
      return req.query.sources ? JSON.parse(req.query.sources) : {};
    } catch {
      throw Object.assign(new Error("Invalid source selection"), {
        status: 400,
      });
    }
  }
  function privateRepository() {
    if (!checkIns)
      throw Object.assign(new Error("Journal encryption is not configured"), {
        status: 503,
      });
    return checkIns;
  }
  function comparisonOptions(req) {
    return { date: req.query.date, days: req.query.days === undefined ? 30 : Number(req.query.days), sources: sources(req), checkIns };
  }
  router.get('/insights', handle(req => service.insights(comparisonOptions(req))));
  router.get('/summary', handle(req => {
    if (req.query.includeSleepCheckIns !== undefined && !['true', 'false'].includes(req.query.includeSleepCheckIns))
      throw Object.assign(new Error('includeSleepCheckIns must be true or false'), { status: 400 });
    return service.summary({ ...comparisonOptions(req), includeSleepCheckIns: req.query.includeSleepCheckIns === 'true' });
  }));
  router.get(
    "/report",
    handle((req) =>
      service.report({
        date: req.query.date,
        sessionId: req.query.sessionId,
        sources: sources(req),
      }),
    ),
  );
  router.get(
    "/trends",
    handle((req) =>
      service.trends({
        start: req.query.start,
        end: req.query.end,
        sources: sources(req),
      }),
    ),
  );
  router.get(
    "/preferences",
    handle(() => service.getPreferences()),
  );
  router.put(
    "/preferences",
    handle((req) => service.setPreferences(req.body)),
  );
  router.get(
    "/check-ins",
    handle((req) => privateRepository().list(req.query.start, req.query.end)),
  );
  router.get(
    "/check-ins/:date",
    handle((req) => privateRepository().get(req.params.date)),
  );
  router.put(
    "/check-ins/:date",
    handle((req) => privateRepository().put(req.params.date, req.body)),
  );
  router.delete(
    "/check-ins/:date",
    handle(async (req) => {
      await privateRepository().remove(req.params.date);
      return { deleted: true };
    }),
  );
  return router;
}
