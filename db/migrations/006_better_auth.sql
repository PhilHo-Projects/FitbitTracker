-- Better Auth core schema (better-auth 1.7.1, Kysely/PostgreSQL adapter).
-- Column names are camelCase because Better Auth quotes identifiers verbatim.

CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "session" (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
);

CREATE INDEX session_user_id_idx ON "session" ("userId");
CREATE INDEX session_expires_at_idx ON "session" ("expiresAt");

CREATE TABLE "account" (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX account_user_id_idx ON "account" ("userId");

CREATE TABLE "verification" (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX verification_identifier_idx ON "verification" (identifier);

CREATE TABLE "rateLimit" (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL DEFAULT 0,
  "lastRequest" bigint NOT NULL DEFAULT 0
);
