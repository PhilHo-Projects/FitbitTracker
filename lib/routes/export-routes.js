import express from 'express';

import { publicExportJob } from '../exports/service.js';

function handler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

export function createExportRouter({ service, requireAuth }) {
  const router = express.Router();
  router.use(requireAuth);

  router.post(
    '/',
    handler(async (req, res) => {
      const job = await service.create({
        exportType: req.body?.exportType,
        startDate: req.body?.startDate,
        endDateExclusive: req.body?.endDateExclusive,
        metrics: req.body?.metrics,
        detailLevel: req.body?.detailLevel,
        includeJournal: req.body?.includeJournal,
        includePng: req.body?.includePng,
      });
      res.status(202).json({ ok: true, data: publicExportJob(job) });
    }),
  );

  router.get(
    '/',
    handler(async (_req, res) => {
      res.json({ ok: true, data: (await service.list()).map(publicExportJob) });
    }),
  );

  router.get(
    '/:id',
    handler(async (req, res) => {
      const job = await service.get(req.params.id);
      if (!job) {
        return res.status(404).json({ ok: false, message: 'Export job not found' });
      }
      return res.json({ ok: true, data: publicExportJob(job) });
    }),
  );

  router.get(
    '/:id/download',
    handler(async (req, res, next) => {
      const file = await service.download(req.params.id);
      res.type(file.contentType);
      res.download(file.filePath, file.fileName, (error) => {
        if (error && !res.headersSent) next(error);
      });
    }),
  );

  return router;
}
