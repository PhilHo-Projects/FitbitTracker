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
  secureCookies = false,
  now = () => Date.now(),
}) {
  const router = express.Router();
  router.use(requireAuth);
  const cookieName = 'google_health_oauth_state';
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: secureCookies, path: '/api/connectors/google/callback' };

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
      res.cookie(cookieName, state, { ...cookieOptions, maxAge: 600_000 });
      res.json({ ok: true, data: { url: oauth.authorizationUrl({ state }) } });
    }),
  );

  router.get(
    '/google/callback',
    handler(async (req, res) => {
      const { code, state, error } = req.query;
      const browserState = String(req.headers.cookie || '').split(';')
        .map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1);
      res.clearCookie(cookieName, cookieOptions);
      if (typeof state !== 'string' || state !== browserState || !verifyState(secret, state, { now: now() })) {
        return res.redirect('/settings?error=invalid_state');
      }
      if (error) return res.redirect(`/settings?error=${error === 'access_denied' ? 'access_denied' : 'connection_failed'}`);
      if (typeof code !== 'string' || !code) return res.redirect('/settings?error=missing_code');
      try {
        await connector.connectWithCode(String(code));
      } catch {
        return res.redirect('/settings?error=connection_failed');
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
