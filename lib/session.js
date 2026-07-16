import crypto from 'node:crypto';

const TOKEN_VERSION = 'v1';

function signatureFor(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(secret, nowMs = Date.now(), ttlMs = 12 * 60 * 60 * 1000) {
  if (!secret) {
    throw new Error('A session secret is required');
  }

  const expiresAt = Math.floor(nowMs + ttlMs);
  const payload = `${TOKEN_VERSION}.${expiresAt}`;
  return `${payload}.${signatureFor(payload, secret)}`;
}

export function verifySessionToken(token, secret, nowMs = Date.now()) {
  if (!token || !secret || typeof token !== 'string') {
    return false;
  }

  const [version, expiresAtText, suppliedSignature, extra] = token.split('.');
  if (extra !== undefined || version !== TOKEN_VERSION || !/^\d+$/.test(expiresAtText ?? '')) {
    return false;
  }

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt) || nowMs > expiresAt || !suppliedSignature) {
    return false;
  }

  const payload = `${version}.${expiresAtText}`;
  const expectedSignature = signatureFor(payload, secret);
  const expectedBuffer = Buffer.from(expectedSignature);
  const suppliedBuffer = Buffer.from(suppliedSignature);

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export function readCookie(cookieHeader, name) {
  if (!cookieHeader || !name) {
    return null;
  }

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }

    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return null;
}
