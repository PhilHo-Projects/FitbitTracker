export function securityHeaders(_req, res, next) {
  res.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

export function validateMutationOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) {
      return res.status(403).json({ ok: false, message: 'Request origin is not allowed' });
    }
  } catch {
    return res.status(403).json({ ok: false, message: 'Request origin is not allowed' });
  }
  return next();
}

export function createLoginThrottle({
  now = () => Date.now(),
  maxAttempts = 5,
  windowMs = 15 * 60 * 1000,
} = {}) {
  const attempts = new Map();

  function stateFor(key) {
    const current = attempts.get(key);
    if (!current || now() - current.startedAt >= windowMs) {
      const next = { count: 0, startedAt: now() };
      attempts.set(key, next);
      return next;
    }
    return current;
  }

  return {
    middleware(req, res, next) {
      const state = stateFor(req.ip || req.socket?.remoteAddress || 'unknown');
      if (state.count >= maxAttempts) {
        const retryAfter = Math.max(1, Math.ceil((windowMs - (now() - state.startedAt)) / 1000));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ ok: false, message: 'Too many login attempts. Try again later.' });
      }
      req.loginThrottleKey = req.ip || req.socket?.remoteAddress || 'unknown';
      return next();
    },
    failed(key) {
      stateFor(key).count += 1;
    },
    succeeded(key) {
      attempts.delete(key);
    },
  };
}
