import { betterAuth } from 'better-auth';

const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const DEFAULT_SESSION_REFRESH_SECONDS = 60 * 60;
const MIN_PASSWORD_LENGTH = 12;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createAuth(options = {}) {
  const { pool = null, env = process.env, allowSignUp = false } = options;
  const secret = env.DASHBOARD_SESSION_SECRET || '';
  if (!pool || !secret) return null;

  const isProduction = env.NODE_ENV === 'production';
  const publicOrigin = env.PUBLIC_ORIGIN || '';

  return betterAuth({
    database: pool,
    secret,
    baseURL: publicOrigin || undefined,
    trustedOrigins: publicOrigin ? [publicOrigin] : [],
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      // The dashboard is a single-owner archive; accounts are seeded by
      // scripts/create-owner.mjs, never through the running server.
      disableSignUp: !allowSignUp,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      requireEmailVerification: false,
    },
    session: {
      expiresIn: positiveNumber(env.DASHBOARD_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS),
      updateAge: DEFAULT_SESSION_REFRESH_SECONDS,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 15 * 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
        secure: isProduction,
      },
      cookies: {
        session_token: { name: isProduction ? '__Host-fitbit_session' : 'fitbit_session' },
      },
    },
  });
}

export const authConstants = {
  DEFAULT_SESSION_TTL_SECONDS,
  MIN_PASSWORD_LENGTH,
};
