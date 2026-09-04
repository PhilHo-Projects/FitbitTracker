import express from 'express';

import { signState, verifyState } from '../connectors/google-oauth.js';

function handler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function createConnectorRouter({
  connector,
  oauth,
  secret,
  requireAuth,
  now = () => Date.now(),
}) {
  const router = express.Router();
  router.use(requireAuth);

  router.get(
    '/google',
    handler(async (_req, res) => {
      res.json({ ok: true, data: await connector.status() });
    }),
  );

  router.post(
    '/google/authorize',
    handler(async (_req, res) => {
      const state = signState(secret, { issuedAt: now() });
      res.json({ ok: true, data: { url: oauth.authorizationUrl({ state }) } });
    }),
  );

  router.get(
    '/google/callback',
    handler(async (req, res) => {
      const { code, state, error } = req.query;
      if (!verifyState(secret, state, { now: now() })) {
        return res.redirect('/settings?error=invalid_state');
      }
      if (error) return res.redirect(`/settings?error=${encodeURIComponent(String(error))}`);
      if (!code) return res.redirect('/settings?error=missing_code');
      try {
        await connector.connectWithCode(String(code));
      } catch (failure) {
        return res.redirect(`/settings?error=${encodeURIComponent(failure.message)}`);
      }
      return res.redirect('/settings?connected=1');
    }),
  );

  router.post(
    '/google/disconnect',
    handler(async (_req, res) => {
      await connector.disconnect();
      res.json({ ok: true });
    }),
  );

  return router;
}
