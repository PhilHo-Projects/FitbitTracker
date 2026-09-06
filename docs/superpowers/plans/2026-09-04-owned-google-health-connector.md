# Owned Google Health Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Google Health OAuth connection out of n8n and into this application, so the weekly reconnect is a tap in the app's own settings page, staleness is visible, and a dead credential raises an alert instead of rotting silently for 42 days.

**Architecture:** A new `connector_credentials` table holds AES-256-GCM-encrypted Google OAuth tokens. A connector service performs single-flight refresh under a row lock. A new `google-health-client.js` calls `health.googleapis.com` directly while preserving the existing gateway's `request()` contract exactly, so `sync-service.js`, the planner, the normalizers and the metric writer are untouched. A `GOOGLE_CONNECTOR_MODE` flag selects between the old n8n gateway and the new direct client, making cutover and rollback configuration rather than code.

**Tech Stack:** Node 20 ESM, Express 4, PostgreSQL 16 (`pg`), Better Auth 1.7.1, `node --test`, `pg-mem` for fast database tests.

**Spec:** `docs/superpowers/specs/2026-09-04-owned-google-health-connector-design.md`

## Global Constraints

- Node 20 ESM only. No TypeScript, no new runtime dependencies without justification.
- Use test-driven development. Write the failing test, watch it fail, then implement.
- `npm test` must pass at the end of every task. It is currently green — keep it green.
- Tests use `pg-mem` via `applyMigrations(pool)`. Migrations must remain pg-mem compatible: no `INCLUDE` outside the pattern already stripped by `lib/db/migrations.js`, and prefer `text` over `bytea`.
- Migrations are additive and immutable. Never edit an applied migration; add a new numbered file.
- Secrets never enter Git, logs, or any API response. Tokens are encrypted at rest and are never returned by `GET /api/connectors/google`.
- `GOOGLE_CONNECTOR_MODE` defaults to `n8n`. Nothing in Tasks 1–8 may change production sync behavior.
- The n8n workflow, `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_TOKEN` stay deployed and functional until Task 11.
- Commit after every task with a conventional-commit subject.
- Branch from `fix/owner-prompt-feedback`.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `lib/crypto/keyring.js` | Versioned AES-256-GCM keyring cipher, shared by journal and connectors |
| `db/migrations/007_connector_credentials.sql` | Connector credential storage |
| `lib/connectors/repository.js` | Persistence + row locking for `connector_credentials` |
| `lib/connectors/google-oauth.js` | Pure Google OAuth: authorize URL, code exchange, refresh, signed state |
| `lib/connectors/google-connector.js` | Stateful connector: single-flight refresh, status, connect/disconnect |
| `lib/connectors/alerts.js` | Edge-triggered outbound alert on disconnection |
| `lib/jobs/google-health-request.js` | Single source of truth for request validation and URL building |
| `lib/jobs/google-health-client.js` | Direct `health.googleapis.com` client, same contract as the gateway |
| `lib/routes/connector-routes.js` | `/api/connectors` HTTP surface |
| `public/settings-ui.js` | Settings view behaviour |
| `scripts/sync-backfill.mjs` | Operator backfill command |
| `db/migrations/008_oxygen_saturation.sql` | SpO2 storage |

**Modified:**

| Path | Change |
|---|---|
| `lib/journal/crypto.js` | Becomes a thin wrapper over `lib/crypto/keyring.js` |
| `lib/auth.js` | Session cookie `sameSite` `strict` → `lax` (required for the OAuth redirect) |
| `lib/jobs/google-health-gateway.js` | Delegates validation to `google-health-request.js` |
| `lib/jobs/planner.js` | SpO2 metrics |
| `lib/metrics/normalizers.js` | SpO2 normalizers |
| `lib/db/metric-writer.js` | SpO2 upserts |
| `lib/jobs/sync-service.js` | SpO2 ingest branch only |
| `lib/db/health-repository.js` | SpO2 in the dashboard payload |
| `server.js` | Wire connector, mode switch, connector routes |
| `public/index.html`, `public/app.js` | Settings view, staleness banner |
| `.env.example`, `README.md`, `docs/hetzner-promotion.md` | New configuration |

**Deleted (Task 11 only):** `n8n/health-hub-workflow.json`, `scripts/build-n8n-workflow.mjs`, `test/workflow.test.js`, `lib/jobs/google-health-gateway.js`.

---

## Task 1: Shared keyring cipher

Extract the journal's AES-256-GCM keyring so connector tokens reuse it instead of duplicating it. `test/journal.test.js` is the safety net — it must pass unchanged.

**Files:**
- Create: `lib/crypto/keyring.js`
- Modify: `lib/journal/crypto.js`
- Test: `test/keyring.test.js`

**Interfaces:**
- Produces: `createKeyringCipher({ serializedKeyring, label, subject, variableName })` returning `{ encrypt(plaintext) -> { ciphertext, nonce, authTag, keyVersion }, decrypt({ ciphertext, nonce, authTag, keyVersion }) -> string }`. `ciphertext`/`nonce`/`authTag` are `Buffer`. `decrypt` accepts `Buffer` or base64 `string` for those three fields.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/keyring.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyringCipher } from '../lib/crypto/keyring.js';

const KEY_ONE = Buffer.alloc(32, 1).toString('base64');
const KEY_TWO = Buffer.alloc(32, 2).toString('base64');

function cipher(serialized = `1:${KEY_ONE}`) {
  return createKeyringCipher({
    serializedKeyring: serialized,
    label: 'connector',
    subject: 'Connector',
    variableName: 'CONNECTOR_ENCRYPTION_KEYS',
  });
}

test('round trips through the newest key version', () => {
  const subject = cipher(`1:${KEY_ONE},2:${KEY_TWO}`);
  const sealed = subject.encrypt('hello');
  assert.equal(sealed.keyVersion, 2);
  assert.equal(subject.decrypt(sealed), 'hello');
});

test('decrypts a value sealed under an older key version', () => {
  const sealed = cipher(`1:${KEY_ONE}`).encrypt('hello');
  assert.equal(cipher(`1:${KEY_ONE},2:${KEY_TWO}`).decrypt(sealed), 'hello');
});

test('accepts base64 strings back from the database', () => {
  const subject = cipher();
  const sealed = subject.encrypt('hello');
  assert.equal(
    subject.decrypt({
      ciphertext: sealed.ciphertext.toString('base64'),
      nonce: sealed.nonce.toString('base64'),
      authTag: sealed.authTag.toString('base64'),
      keyVersion: sealed.keyVersion,
    }),
    'hello',
  );
});

test('rejects a ciphertext sealed under a different label', () => {
  const sealed = createKeyringCipher({
    serializedKeyring: `1:${KEY_ONE}`,
    label: 'journal',
    subject: 'Journal',
    variableName: 'JOURNAL_ENCRYPTION_KEYS',
  }).encrypt('hello');
  assert.throws(() => cipher().decrypt(sealed));
});

test('names the missing variable when the keyring is empty', () => {
  assert.throws(() => cipher(''), /CONNECTOR_ENCRYPTION_KEYS/);
});

test('reports an unavailable key version using the subject', () => {
  const sealed = cipher(`1:${KEY_ONE}`).encrypt('hello');
  assert.throws(
    () => cipher(`2:${KEY_TWO}`).decrypt(sealed),
    /Connector encryption key version 1 is unavailable/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/keyring.test.js`
Expected: FAIL — cannot find module `../lib/crypto/keyring.js`.

- [ ] **Step 3: Implement the shared cipher**

Create `lib/crypto/keyring.js`. This is `lib/journal/crypto.js` with the three message fragments and the AAD label parameterised — copy the body verbatim and change only what is noted:

```js
import crypto from 'node:crypto';

function parseKeyring(serialized, { subject, variableName }) {
  const keys = new Map();
  for (const entry of String(serialized || '').split(',')) {
    const [versionText, encoded] = entry.trim().split(':', 2);
    if (!versionText || !encoded) continue;
    const version = Number(versionText);
    const key = Buffer.from(encoded, 'base64');
    if (!Number.isInteger(version) || version < 1 || key.length !== 32) {
      throw new Error(
        `Each ${subject.toLowerCase()} encryption key must be version:base64 with exactly 32 bytes`,
      );
    }
    keys.set(version, key);
  }
  if (!keys.size) {
    throw new Error(`${variableName} must contain at least one AES-256 key`);
  }
  return keys;
}

function databaseBuffer(value) {
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const text = buffer.toString('ascii');
  if (buffer.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length < buffer.length) return decoded;
  }
  return buffer;
}

export function createKeyringCipher({ serializedKeyring, label, subject, variableName }) {
  const keys = parseKeyring(serializedKeyring, { subject, variableName });
  const currentVersion = Math.max(...keys.keys());

  return {
    encrypt(plaintext) {
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', keys.get(currentVersion), nonce);
      cipher.setAAD(Buffer.from(`${label}:v${currentVersion}`));
      const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: currentVersion };
    },

    decrypt({ ciphertext, nonce, authTag, keyVersion }) {
      const version = Number(keyVersion);
      const key = keys.get(version);
      if (!key) throw new Error(`${subject} encryption key version ${version} is unavailable`);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, databaseBuffer(nonce));
      decipher.setAAD(Buffer.from(`${label}:v${version}`));
      decipher.setAuthTag(databaseBuffer(authTag));
      return Buffer.concat([
        decipher.update(databaseBuffer(ciphertext)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
```

- [ ] **Step 4: Rewrite the journal cipher as a wrapper**

Replace the entire contents of `lib/journal/crypto.js` with:

```js
import { createKeyringCipher } from '../crypto/keyring.js';

export function createJournalCipher(serializedKeyring) {
  return createKeyringCipher({
    serializedKeyring,
    label: 'journal',
    subject: 'Journal',
    variableName: 'JOURNAL_ENCRYPTION_KEYS',
  });
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. `test/journal.test.js` must pass **unchanged** — if it fails, the extraction altered behavior. Fix `lib/crypto/keyring.js`, never the journal test.

- [ ] **Step 6: Commit**

```bash
git add lib/crypto/keyring.js lib/journal/crypto.js test/keyring.test.js
git commit -m "refactor: share the versioned keyring cipher"
```

---

## Task 2: Connector credential storage

**Files:**
- Create: `db/migrations/007_connector_credentials.sql`, `lib/connectors/repository.js`
- Test: `test/connector-repository.test.js`

**Interfaces:**
- Consumes: `createKeyringCipher` from Task 1.
- Produces: `createConnectorRepository(pool, cipher)` with:
  - `load(provider)` → `null` or `{ provider, status, googleAccountEmail, scope, accessToken, refreshToken, accessTokenExpiresAt, connectedAt, disconnectedAt, lastRefreshAt, lastError, alertedAt }` (tokens decrypted)
  - `save(provider, { googleAccountEmail, scope, accessToken, refreshToken, accessTokenExpiresAt })` → upserts and sets `status = 'connected'`
  - `markDisconnected(provider, message)` → sets `status = 'disconnected'`, `last_error`, `disconnected_at`
  - `markAlerted(provider, at)` → sets `alerted_at`
  - `withLock(provider, fn)` → opens a transaction, `SELECT ... FOR UPDATE` on the row, invokes `fn(lockedRow, client)`, commits

Note: token columns are `text` holding base64, not `bytea` — pg-mem handles `text` reliably and `databaseBuffer` already accepts base64 strings.

- [ ] **Step 1: Write the failing test**

Create `test/connector-repository.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { newDb } from 'pg-mem';

import { createKeyringCipher } from '../lib/crypto/keyring.js';
import { applyMigrations } from '../lib/db/migrations.js';
import { createConnectorRepository } from '../lib/connectors/repository.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

async function createRepository() {
  const memory = newDb({ noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await applyMigrations(pool);
  const cipher = createKeyringCipher({
    serializedKeyring: `1:${KEY}`,
    label: 'connector',
    subject: 'Connector',
    variableName: 'CONNECTOR_ENCRYPTION_KEYS',
  });
  return { pool, repository: createConnectorRepository(pool, cipher) };
}

test('returns null before anything is stored', async () => {
  const { repository } = await createRepository();
  assert.equal(await repository.load('google-health'), null);
});

test('round trips tokens and reports connected', async () => {
  const { repository } = await createRepository();
  const expiresAt = new Date('2026-09-04T17:00:00Z');
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a b',
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    accessTokenExpiresAt: expiresAt,
  });
  const stored = await repository.load('google-health');
  assert.equal(stored.status, 'connected');
  assert.equal(stored.accessToken, 'access-value');
  assert.equal(stored.refreshToken, 'refresh-value');
  assert.equal(stored.googleAccountEmail, 'owner@example.com');
  assert.equal(new Date(stored.accessTokenExpiresAt).toISOString(), expiresAt.toISOString());
});

test('never stores a token in plaintext', async () => {
  const { pool, repository } = await createRepository();
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    accessTokenExpiresAt: new Date(),
  });
  const raw = JSON.stringify(
    (await pool.query('SELECT * FROM connector_credentials')).rows,
  );
  assert.ok(!raw.includes('access-value'));
  assert.ok(!raw.includes('refresh-value'));
});

test('marking disconnected keeps the refresh token but changes status', async () => {
  const { repository } = await createRepository();
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
    accessTokenExpiresAt: new Date(),
  });
  await repository.markDisconnected('google-health', 'invalid_grant');
  const stored = await repository.load('google-health');
  assert.equal(stored.status, 'disconnected');
  assert.equal(stored.lastError, 'invalid_grant');
  assert.ok(stored.disconnectedAt);
});

test('reconnecting clears the previous error and alert', async () => {
  const { repository } = await createRepository();
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'a1',
    refreshToken: 'r1',
    accessTokenExpiresAt: new Date(),
  });
  await repository.markDisconnected('google-health', 'invalid_grant');
  await repository.markAlerted('google-health', new Date());
  await repository.save('google-health', {
    googleAccountEmail: 'owner@example.com',
    scope: 'a',
    accessToken: 'a2',
    refreshToken: 'r2',
    accessTokenExpiresAt: new Date(),
  });
  const stored = await repository.load('google-health');
  assert.equal(stored.status, 'connected');
  assert.equal(stored.lastError, null);
  assert.equal(stored.alertedAt, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connector-repository.test.js`
Expected: FAIL — cannot find module `../lib/connectors/repository.js`.

- [ ] **Step 3: Write the migration**

Create `db/migrations/007_connector_credentials.sql`:

```sql
-- Third-party API connections owned by this application.
-- Distinct from Better Auth's "account" table, which describes login identities.

CREATE TABLE connector_credentials (
  id uuid PRIMARY KEY,
  provider text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'disconnected',
  google_account_email text,
  scope text,
  access_token_ciphertext text,
  access_token_nonce text,
  access_token_auth_tag text,
  refresh_token_ciphertext text,
  refresh_token_nonce text,
  refresh_token_auth_tag text,
  key_version integer,
  access_token_expires_at timestamptz,
  connected_at timestamptz,
  disconnected_at timestamptz,
  last_refresh_at timestamptz,
  last_error text,
  alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

- [ ] **Step 4: Implement the repository**

Create `lib/connectors/repository.js`:

```js
import crypto from 'node:crypto';

function sealed(cipher, value) {
  if (value === null || value === undefined) {
    return { ciphertext: null, nonce: null, authTag: null };
  }
  const result = cipher.encrypt(value);
  return {
    ciphertext: result.ciphertext.toString('base64'),
    nonce: result.nonce.toString('base64'),
    authTag: result.authTag.toString('base64'),
    keyVersion: result.keyVersion,
  };
}

function opened(cipher, ciphertext, nonce, authTag, keyVersion) {
  if (!ciphertext || !nonce || !authTag) return null;
  return cipher.decrypt({ ciphertext, nonce, authTag, keyVersion });
}

function present(cipher, row) {
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    googleAccountEmail: row.google_account_email,
    scope: row.scope,
    accessToken: opened(
      cipher,
      row.access_token_ciphertext,
      row.access_token_nonce,
      row.access_token_auth_tag,
      row.key_version,
    ),
    refreshToken: opened(
      cipher,
      row.refresh_token_ciphertext,
      row.refresh_token_nonce,
      row.refresh_token_auth_tag,
      row.key_version,
    ),
    accessTokenExpiresAt: row.access_token_expires_at,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    lastRefreshAt: row.last_refresh_at,
    lastError: row.last_error,
    alertedAt: row.alerted_at,
  };
}

export function createConnectorRepository(pool, cipher) {
  async function loadWith(runner, provider) {
    const rows = await runner.query(
      'SELECT * FROM connector_credentials WHERE provider = $1',
      [provider],
    );
    return present(cipher, rows.rows[0]);
  }

  return {
    load: (provider) => loadWith(pool, provider),

    async save(provider, {
      googleAccountEmail,
      scope,
      accessToken,
      refreshToken,
      accessTokenExpiresAt,
    }, runner = pool) {
      const access = sealed(cipher, accessToken);
      const refresh = sealed(cipher, refreshToken);
      await runner.query(
        `INSERT INTO connector_credentials (
           id, provider, status, google_account_email, scope,
           access_token_ciphertext, access_token_nonce, access_token_auth_tag,
           refresh_token_ciphertext, refresh_token_nonce, refresh_token_auth_tag,
           key_version, access_token_expires_at, connected_at,
           disconnected_at, last_refresh_at, last_error, alerted_at
         ) VALUES (
           $1, $2, 'connected', $3, $4,
           $5, $6, $7,
           $8, $9, $10,
           $11, $12, CURRENT_TIMESTAMP,
           NULL, CURRENT_TIMESTAMP, NULL, NULL
         )
         ON CONFLICT (provider) DO UPDATE SET
           status = 'connected',
           google_account_email = EXCLUDED.google_account_email,
           scope = EXCLUDED.scope,
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           access_token_nonce = EXCLUDED.access_token_nonce,
           access_token_auth_tag = EXCLUDED.access_token_auth_tag,
           refresh_token_ciphertext = COALESCE(
             EXCLUDED.refresh_token_ciphertext,
             connector_credentials.refresh_token_ciphertext
           ),
           refresh_token_nonce = COALESCE(
             EXCLUDED.refresh_token_nonce,
             connector_credentials.refresh_token_nonce
           ),
           refresh_token_auth_tag = COALESCE(
             EXCLUDED.refresh_token_auth_tag,
             connector_credentials.refresh_token_auth_tag
           ),
           key_version = EXCLUDED.key_version,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           connected_at = COALESCE(connector_credentials.connected_at, CURRENT_TIMESTAMP),
           disconnected_at = NULL,
           last_refresh_at = CURRENT_TIMESTAMP,
           last_error = NULL,
           alerted_at = NULL,
           updated_at = CURRENT_TIMESTAMP`,
        [
          crypto.randomUUID(),
          provider,
          googleAccountEmail ?? null,
          scope ?? null,
          access.ciphertext,
          access.nonce,
          access.authTag,
          refresh.ciphertext,
          refresh.nonce,
          refresh.authTag,
          access.keyVersion ?? refresh.keyVersion ?? null,
          accessTokenExpiresAt ?? null,
        ],
      );
    },

    async markDisconnected(provider, message, runner = pool) {
      await runner.query(
        `UPDATE connector_credentials
         SET status = 'disconnected',
             last_error = $2,
             disconnected_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE provider = $1`,
        [provider, message ?? null],
      );
    },

    async markAlerted(provider, at, runner = pool) {
      await runner.query(
        'UPDATE connector_credentials SET alerted_at = $2, updated_at = CURRENT_TIMESTAMP WHERE provider = $1',
        [provider, at ?? new Date()],
      );
    },

    async withLock(provider, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const rows = await client.query(
          'SELECT * FROM connector_credentials WHERE provider = $1 FOR UPDATE',
          [provider],
        );
        const result = await fn(present(cipher, rows.rows[0]), client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/connector-repository.test.js && npm test`
Expected: PASS. If pg-mem rejects `FOR UPDATE`, drop that clause **only** when `pool.constructor?.name === 'MemPg'`, following the precedent in `lib/db/migrations.js:7`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/007_connector_credentials.sql lib/connectors/repository.js test/connector-repository.test.js
git commit -m "feat: store encrypted connector credentials"
```

---

## Task 3: Google OAuth client

Pure functions only. No database, no state.

**Files:**
- Create: `lib/connectors/google-oauth.js`
- Test: `test/google-oauth.test.js`

**Interfaces:**
- Produces:
  - `GOOGLE_HEALTH_SCOPES` — array of the four scope URLs
  - `signState(secret, { nonce, issuedAt })` → string
  - `verifyState(secret, state, { now, maxAgeMs })` → boolean
  - `createGoogleOAuthClient({ clientId, clientSecret, redirectUri, fetchImpl })` with
    `authorizationUrl({ state })` → string,
    `exchangeCode(code)` → `{ accessToken, refreshToken, expiresInSeconds, scope, idToken }`,
    `refresh(refreshToken)` → same shape with `refreshToken` possibly `null`
  - Failures throw `Error` with `.fatal === true` when Google returned `invalid_grant`, otherwise `.fatal === false`.

- [ ] **Step 1: Write the failing test**

Create `test/google-oauth.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGoogleOAuthClient,
  GOOGLE_HEALTH_SCOPES,
  signState,
  verifyState,
} from '../lib/connectors/google-oauth.js';

function client(fetchImpl) {
  return createGoogleOAuthClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://example.com/api/connectors/google/callback',
    fetchImpl,
  });
}

test('requests exactly the four health scopes', () => {
  assert.equal(GOOGLE_HEALTH_SCOPES.length, 4);
  assert.ok(
    GOOGLE_HEALTH_SCOPES.includes(
      'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    ),
  );
  for (const unwanted of ['location', 'nutrition', 'ecg', 'irn']) {
    assert.ok(!GOOGLE_HEALTH_SCOPES.some((scope) => scope.includes(unwanted)));
  }
});

test('the authorization url forces a refresh token to be issued', () => {
  const url = new URL(client().authorizationUrl({ state: 'abc' }));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'abc');
  assert.equal(url.searchParams.get('scope'), GOOGLE_HEALTH_SCOPES.join(' '));
});

test('signed state round trips and rejects tampering', () => {
  const state = signState('secret', { nonce: 'n1', issuedAt: 1000 });
  assert.equal(verifyState('secret', state, { now: 2000, maxAgeMs: 600_000 }), true);
  assert.equal(verifyState('other-secret', state, { now: 2000, maxAgeMs: 600_000 }), false);
  assert.equal(verifyState('secret', `${state}x`, { now: 2000, maxAgeMs: 600_000 }), false);
});

test('signed state expires', () => {
  const state = signState('secret', { nonce: 'n1', issuedAt: 1000 });
  assert.equal(verifyState('secret', state, { now: 999_999, maxAgeMs: 600_000 }), false);
});

test('exchangeCode returns normalized tokens', async () => {
  const subject = client(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'a1',
      refresh_token: 'r1',
      expires_in: 3599,
      scope: 'one two',
      id_token: 'id1',
    }),
  }));
  const result = await subject.exchangeCode('code-value');
  assert.deepEqual(result, {
    accessToken: 'a1',
    refreshToken: 'r1',
    expiresInSeconds: 3599,
    scope: 'one two',
    idToken: 'id1',
  });
});

test('invalid_grant is fatal', async () => {
  const subject = client(async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Bad Request' }),
  }));
  await assert.rejects(subject.refresh('r1'), (error) => {
    assert.equal(error.fatal, true);
    assert.match(error.message, /invalid_grant/);
    return true;
  });
});

test('a server error is not fatal', async () => {
  const subject = client(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'backend_error' }),
  }));
  await assert.rejects(subject.refresh('r1'), (error) => {
    assert.equal(error.fatal, false);
    return true;
  });
});

test('refresh tolerates Google omitting a new refresh token', async () => {
  const subject = client(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'a2', expires_in: 3599, scope: 'one' }),
  }));
  const result = await subject.refresh('r1');
  assert.equal(result.accessToken, 'a2');
  assert.equal(result.refreshToken, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/google-oauth.test.js`
Expected: FAIL — cannot find module `../lib/connectors/google-oauth.js`.

- [ ] **Step 3: Implement**

Create `lib/connectors/google-oauth.js`:

```js
import crypto from 'node:crypto';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_HEALTH_SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.profile.readonly',
];

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signState(secret, { nonce = crypto.randomUUID(), issuedAt = Date.now() } = {}) {
  const payload = `${nonce}.${issuedAt}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyState(secret, state, { now = Date.now(), maxAgeMs = 600_000 } = {}) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAt, signature] = parts;
  const expected = sign(secret, `${nonce}.${issuedAt}`);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return false;
  const issued = Number(issuedAt);
  return Number.isFinite(issued) && now - issued <= maxAgeMs && now >= issued;
}

function tokenError(body, status) {
  const code = body?.error || `HTTP ${status}`;
  const error = new Error(
    body?.error_description ? `${code}: ${body.error_description}` : String(code),
  );
  error.fatal = code === 'invalid_grant';
  error.status = status;
  return error;
}

export function createGoogleOAuthClient({
  clientId,
  clientSecret,
  redirectUri,
  fetchImpl = globalThis.fetch,
}) {
  async function token(parameters) {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw tokenError(body, response.status);
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresInSeconds: Number(body.expires_in) || 0,
      scope: body.scope ?? null,
      idToken: body.id_token ?? null,
    };
  }

  return {
    authorizationUrl({ state }) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'false',
        scope: GOOGLE_HEALTH_SCOPES.join(' '),
        state,
      }).toString();
      return url.toString();
    },

    exchangeCode: (code) =>
      token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),

    refresh: (refreshToken) =>
      token({ refresh_token: refreshToken, grant_type: 'refresh_token' }),
  };
}
```

Note: `exchangeCode` returns `idToken` but the test above asserts the full object shape — keep the property order irrelevant, `deepEqual` compares by key.

- [ ] **Step 4: Run tests**

Run: `node --test test/google-oauth.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/connectors/google-oauth.js test/google-oauth.test.js
git commit -m "feat: add a direct Google OAuth client"
```

---

## Task 4: Single-flight connector service

The highest-risk component. `sync-service.runOnce()` polls on a 1s timer; when the access token expires several chunks can demand a refresh at once.

**Files:**
- Create: `lib/connectors/google-connector.js`
- Test: `test/google-connector.test.js`

**Interfaces:**
- Consumes: `createConnectorRepository` (Task 2), `createGoogleOAuthClient` (Task 3).
- Produces: `createGoogleConnector({ repository, oauth, now, refreshSkewMs, onDisconnect })` with
  - `accessToken()` → string, refreshing if needed. Throws `Error` with `.disconnected === true` when there is no usable credential.
  - `status()` → `{ connected, email, scope, accessTokenExpiresAt, connectedAt, disconnectedAt, lastError }` — **never tokens**
  - `connectWithCode(code)` → stores the exchanged tokens
  - `disconnect()` → marks disconnected

- [ ] **Step 1: Write the failing test**

Create `test/google-connector.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoogleConnector } from '../lib/connectors/google-connector.js';

function stubRepository(initial) {
  let row = initial;
  return {
    calls: { save: 0, markDisconnected: 0 },
    async load() {
      return row;
    },
    async save(_provider, values) {
      this.calls.save += 1;
      row = {
        ...row,
        status: 'connected',
        accessToken: values.accessToken,
        refreshToken: values.refreshToken ?? row?.refreshToken,
        accessTokenExpiresAt: values.accessTokenExpiresAt,
        lastError: null,
      };
    },
    async markDisconnected(_provider, message) {
      this.calls.markDisconnected += 1;
      row = { ...row, status: 'disconnected', lastError: message };
    },
    async markAlerted() {},
    async withLock(_provider, fn) {
      return fn(row, null);
    },
  };
}

const FRESH = {
  provider: 'google-health',
  status: 'connected',
  accessToken: 'current',
  refreshToken: 'r1',
  accessTokenExpiresAt: new Date('2026-09-04T18:00:00Z'),
};

const STALE = { ...FRESH, accessTokenExpiresAt: new Date('2026-09-04T16:00:00Z') };
const AT = () => Date.parse('2026-09-04T17:00:00Z');

test('returns the stored access token while it is still valid', async () => {
  const repository = stubRepository(FRESH);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: { async refresh() { refreshes += 1; return {}; } },
    now: AT,
  });
  assert.equal(await connector.accessToken(), 'current');
  assert.equal(refreshes, 0);
});

test('refreshes exactly once for concurrent callers', async () => {
  const repository = stubRepository(STALE);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { accessToken: 'fresh', refreshToken: 'r2', expiresInSeconds: 3599, scope: 'a' };
      },
    },
    now: AT,
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => connector.accessToken()),
  );
  assert.deepEqual(new Set(results), new Set(['fresh']));
  assert.equal(refreshes, 1, 'concurrent callers must share one refresh');
  assert.equal(repository.calls.save, 1);
});

test('a fatal refresh marks the credential disconnected and does not retry', async () => {
  const repository = stubRepository(STALE);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        refreshes += 1;
        throw Object.assign(new Error('invalid_grant: Bad Request'), { fatal: true });
      },
    },
    now: AT,
  });
  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
  assert.equal(refreshes, 1, 'a disconnected credential must not be retried');
  assert.equal(repository.calls.markDisconnected, 1);
});

test('a transient refresh failure stays retryable', async () => {
  const repository = stubRepository(STALE);
  let refreshes = 0;
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        refreshes += 1;
        if (refreshes === 1) throw Object.assign(new Error('backend_error'), { fatal: false });
        return { accessToken: 'fresh', refreshToken: null, expiresInSeconds: 3599, scope: 'a' };
      },
    },
    now: AT,
  });
  await assert.rejects(connector.accessToken());
  assert.equal(await connector.accessToken(), 'fresh');
  assert.equal(repository.calls.markDisconnected, 0);
});

test('status never exposes tokens', async () => {
  const connector = createGoogleConnector({
    repository: stubRepository(FRESH),
    oauth: {},
    now: AT,
  });
  const status = await connector.status();
  assert.equal(status.connected, true);
  assert.ok(!JSON.stringify(status).includes('current'));
  assert.ok(!JSON.stringify(status).includes('r1'));
});

test('a missing credential reports disconnected rather than throwing', async () => {
  const connector = createGoogleConnector({
    repository: stubRepository(null),
    oauth: {},
    now: AT,
  });
  assert.equal((await connector.status()).connected, false);
  await assert.rejects(connector.accessToken(), (error) => error.disconnected === true);
});

test('onDisconnect fires once on the connected to disconnected edge', async () => {
  const repository = stubRepository(STALE);
  const fired = [];
  const connector = createGoogleConnector({
    repository,
    oauth: {
      async refresh() {
        throw Object.assign(new Error('invalid_grant'), { fatal: true });
      },
    },
    now: AT,
    onDisconnect: (message) => fired.push(message),
  });
  await assert.rejects(connector.accessToken());
  await assert.rejects(connector.accessToken());
  assert.equal(fired.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/google-connector.test.js`
Expected: FAIL — cannot find module `../lib/connectors/google-connector.js`.

- [ ] **Step 3: Implement**

Create `lib/connectors/google-connector.js`:

```js
const PROVIDER = 'google-health';
const DEFAULT_SKEW_MS = 120_000;

function disconnectedError(message) {
  const error = new Error(message || 'Google Health is not connected');
  error.disconnected = true;
  error.transient = false;
  error.status = 401;
  return error;
}

export function createGoogleConnector({
  repository,
  oauth,
  now = () => Date.now(),
  refreshSkewMs = DEFAULT_SKEW_MS,
  onDisconnect = null,
}) {
  let inFlight = null;

  function usable(row) {
    if (!row || row.status !== 'connected' || !row.accessToken) return false;
    const expiresAt = row.accessTokenExpiresAt
      ? new Date(row.accessTokenExpiresAt).getTime()
      : 0;
    return expiresAt - refreshSkewMs > now();
  }

  async function performRefresh() {
    return repository.withLock(PROVIDER, async (locked, client) => {
      // Double-checked under the row lock: another process may have refreshed
      // while this one waited for the lock.
      if (usable(locked)) return locked.accessToken;
      if (!locked || !locked.refreshToken) throw disconnectedError();

      let tokens;
      try {
        tokens = await oauth.refresh(locked.refreshToken);
      } catch (error) {
        if (!error.fatal) throw error;
        const alreadyDisconnected = locked.status === 'disconnected';
        await repository.markDisconnected(PROVIDER, error.message, client ?? undefined);
        if (!alreadyDisconnected && onDisconnect) await onDisconnect(error.message);
        throw disconnectedError(error.message);
      }

      await repository.save(
        PROVIDER,
        {
          googleAccountEmail: locked.googleAccountEmail,
          scope: tokens.scope ?? locked.scope,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? null,
          accessTokenExpiresAt: new Date(now() + tokens.expiresInSeconds * 1000),
        },
        client ?? undefined,
      );
      return tokens.accessToken;
    });
  }

  return {
    async accessToken() {
      const row = await repository.load(PROVIDER);
      if (usable(row)) return row.accessToken;
      if (row && row.status === 'disconnected') throw disconnectedError(row.lastError);
      if (inFlight) return inFlight;
      inFlight = performRefresh().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    async status() {
      const row = await repository.load(PROVIDER);
      return {
        connected: Boolean(row && row.status === 'connected'),
        email: row?.googleAccountEmail ?? null,
        scope: row?.scope ?? null,
        accessTokenExpiresAt: row?.accessTokenExpiresAt ?? null,
        connectedAt: row?.connectedAt ?? null,
        disconnectedAt: row?.disconnectedAt ?? null,
        lastError: row?.lastError ?? null,
      };
    },

    async connectWithCode(code) {
      const tokens = await oauth.exchangeCode(code);
      if (!tokens.refreshToken) {
        throw new Error('Google did not return a refresh token; re-consent is required');
      }
      await repository.save(PROVIDER, {
        googleAccountEmail: null,
        scope: tokens.scope,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: new Date(now() + tokens.expiresInSeconds * 1000),
      });
    },

    disconnect: () => repository.markDisconnected(PROVIDER, 'Disconnected by the owner'),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/google-connector.test.js && npm test`
Expected: PASS. The `refreshes === 1` assertion under 8 concurrent callers is the point of this task — do not relax it.

- [ ] **Step 5: Commit**

```bash
git add lib/connectors/google-connector.js test/google-connector.test.js
git commit -m "feat: refresh Google tokens under a single-flight lock"
```

---

## Task 5: Direct Google Health client

Collapse the duplicated validation into one module and call Google directly.

**Files:**
- Create: `lib/jobs/google-health-request.js`, `lib/jobs/google-health-client.js`
- Modify: `lib/jobs/google-health-gateway.js`
- Test: `test/google-health-client.test.js`

**Interfaces:**
- Produces:
  - `validateGoogleHealthRequest(request)` — throws `Error('Unsupported gateway request')` on rejection
  - `buildGoogleHealthRequest(request)` → `{ method, url, body }`
  - `createGoogleHealthClient({ connector, fetchImpl, timeoutMs })` with `request(...)` returning `{ ok, metric, status, data, nextPageToken, message }` — identical to the gateway's contract
- Consumes: `createGoogleConnector` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `test/google-health-client.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoogleHealthClient } from '../lib/jobs/google-health-client.js';
import { buildGoogleHealthRequest } from '../lib/jobs/google-health-request.js';

const connector = { async accessToken() { return 'token-value'; } };

test('builds a list url with a civil-time filter', () => {
  const built = buildGoogleHealthRequest({
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-09-01',
    endDateExclusive: '2026-09-02',
  });
  const url = new URL(built.url);
  assert.equal(url.origin, 'https://health.googleapis.com');
  assert.equal(url.pathname, '/v4/users/me/dataTypes/heart-rate/dataPoints');
  assert.equal(
    url.searchParams.get('filter'),
    'heart_rate.sample_time.civil_time >= "2026-09-01" AND heart_rate.sample_time.civil_time < "2026-09-02"',
  );
  assert.equal(built.method, 'GET');
});

test('sleep reconcile targets the wearables data source family', () => {
  const url = new URL(
    buildGoogleHealthRequest({
      operation: 'reconcile',
      metric: 'sleep',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    }).url,
  );
  assert.equal(url.pathname, '/v4/users/me/dataTypes/sleep/dataPoints:reconcile');
  assert.equal(
    url.searchParams.get('dataSourceFamily'),
    'users/me/dataSourceFamilies/google-wearables',
  );
  assert.equal(url.searchParams.get('pageSize'), '25');
});

test('total-calories rollup posts a range body', () => {
  const built = buildGoogleHealthRequest({
    operation: 'rollUp',
    metric: 'total-calories',
    startDate: '2026-09-01',
    endDateExclusive: '2026-09-02',
    timezone: 'America/Toronto',
  });
  assert.equal(built.method, 'POST');
  assert.match(built.url, /dataPoints:rollUp$/);
  assert.equal(built.body.windowSize, '3600s');
  assert.ok(built.body.range.startTime);
});

test('rejects an unsupported operation and metric pair', () => {
  assert.throws(
    () => buildGoogleHealthRequest({ operation: 'rollUp', metric: 'sleep' }),
    /Unsupported gateway request/,
  );
});

test('sends the bearer token and unwraps the response', async () => {
  let seen = null;
  const client = createGoogleHealthClient({
    connector,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ dataPoints: [{ a: 1 }], nextPageToken: 'next' }),
      };
    },
  });
  const result = await client.request({
    operation: 'list',
    metric: 'heart-rate',
    startDate: '2026-09-01',
    endDateExclusive: '2026-09-02',
  });
  assert.equal(seen.options.headers.authorization, 'Bearer token-value');
  assert.equal(result.ok, true);
  assert.equal(result.metric, 'heart-rate');
  assert.equal(result.nextPageToken, 'next');
  assert.deepEqual(result.data.dataPoints, [{ a: 1 }]);
});

test('marks 5xx and 429 transient and 4xx permanent', async () => {
  const build = (status) =>
    createGoogleHealthClient({
      connector,
      fetchImpl: async () => ({
        ok: false,
        status,
        json: async () => ({ error: { message: 'nope' } }),
      }),
    }).request({
      operation: 'list',
      metric: 'heart-rate',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    });

  await assert.rejects(build(503), (error) => error.transient === true);
  await assert.rejects(build(429), (error) => error.transient === true);
  await assert.rejects(build(400), (error) => error.transient === false);
});

test('a disconnected connector surfaces as a permanent failure', async () => {
  const client = createGoogleHealthClient({
    connector: {
      async accessToken() {
        throw Object.assign(new Error('invalid_grant'), { disconnected: true, transient: false });
      },
    },
    fetchImpl: async () => {
      throw new Error('fetch must not be called when disconnected');
    },
  });
  await assert.rejects(
    client.request({
      operation: 'list',
      metric: 'heart-rate',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    }),
    (error) => error.transient === false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/google-health-client.test.js`
Expected: FAIL — cannot find module `../lib/jobs/google-health-client.js`.

- [ ] **Step 3: Implement the shared request module**

Create `lib/jobs/google-health-request.js`. The operation/metric tables and URL construction are ported from the `Validate and Prepare` node in `n8n/health-hub-workflow.json` — this file becomes their only home:

```js
import { GOOGLE_HEALTH_METRICS } from './planner.js';

const BASE = 'https://health.googleapis.com/v4/users/me';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const OPERATIONS = new Set(['profile', 'identity', 'list', 'reconcile', 'rollUp']);

export const COMBINATIONS = {
  profile: new Set(['sleep']),
  identity: new Set(['sleep']),
  list: new Set([
    'heart-rate',
    'daily-resting-heart-rate',
    'active-energy-burned',
    'basal-energy-burned',
  ]),
  reconcile: new Set(['sleep']),
  rollUp: new Set(['total-calories']),
};

export const FILTER_FIELDS = {
  sleep: 'sleep.interval.civil_end_time',
  'heart-rate': 'heart_rate.sample_time.civil_time',
  'daily-resting-heart-rate': 'daily_resting_heart_rate.date',
  'active-energy-burned': 'active_energy_burned.interval.civil_start_time',
  'basal-energy-burned': 'basal_energy_burned.interval.civil_start_time',
};

export function validateGoogleHealthRequest(request) {
  if (
    !OPERATIONS.has(request.operation) ||
    !GOOGLE_HEALTH_METRICS.includes(request.metric) ||
    !COMBINATIONS[request.operation]?.has(request.metric)
  ) {
    throw new Error('Unsupported gateway request');
  }
  if (!['profile', 'identity'].includes(request.operation)) {
    if (
      !DATE_PATTERN.test(String(request.startDate || '')) ||
      !DATE_PATTERN.test(String(request.endDateExclusive || '')) ||
      request.startDate >= request.endDateExclusive
    ) {
      throw new Error('Unsupported gateway request');
    }
  }
  if (request.operation === 'rollUp' && !String(request.timezone || '').trim()) {
    throw new Error('Unsupported gateway request');
  }
}

function zonedIso(date, timezone) {
  // Resolve the UTC instant of local midnight on `date` in `timezone`.
  const guess = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(guess);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  const asUtc = Date.parse(
    `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}Z`,
  );
  return new Date(guess.getTime() * 2 - asUtc).toISOString();
}

export function buildGoogleHealthRequest(request) {
  validateGoogleHealthRequest(request);

  if (request.operation === 'profile' || request.operation === 'identity') {
    return { method: 'GET', url: `${BASE}/${request.operation}`, body: null };
  }

  if (request.operation === 'rollUp') {
    return {
      method: 'POST',
      url: `${BASE}/dataTypes/${request.metric}/dataPoints:rollUp`,
      body: {
        range: {
          startTime: zonedIso(request.startDate, request.timezone),
          endTime: zonedIso(request.endDateExclusive, request.timezone),
        },
        windowSize: '3600s',
      },
    };
  }

  const suffix = request.operation === 'reconcile' ? 'dataPoints:reconcile' : 'dataPoints';
  const filterField = FILTER_FIELDS[request.metric];
  const query = new URLSearchParams({
    pageSize: request.metric === 'sleep' ? '25' : '10000',
    filter:
      `${filterField} >= "${request.startDate}" AND ${filterField} < "${request.endDateExclusive}"`,
  });
  if (request.operation === 'reconcile') {
    query.set('dataSourceFamily', 'users/me/dataSourceFamilies/google-wearables');
  }
  if (request.pageToken) query.set('pageToken', request.pageToken);

  return {
    method: 'GET',
    url: `${BASE}/dataTypes/${request.metric}/${suffix}?${query.toString()}`,
    body: null,
  };
}
```

- [ ] **Step 4: Implement the client**

Create `lib/jobs/google-health-client.js`:

```js
import { buildGoogleHealthRequest } from './google-health-request.js';

export function createGoogleHealthClient({
  connector,
  fetchImpl = globalThis.fetch,
  timeoutMs = 35_000,
}) {
  return {
    async request(request) {
      const built = buildGoogleHealthRequest(request);

      let token;
      try {
        token = await connector.accessToken();
      } catch (error) {
        error.transient = false;
        throw error;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(built.url, {
          method: built.method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(built.body ? { 'content-type': 'application/json' } : {}),
          },
          ...(built.body ? { body: JSON.stringify(built.body) } : {}),
          signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.error) {
          const error = new Error(
            body?.error?.message || body?.message || `Google Health returned HTTP ${response.status}`,
          );
          error.status = response.status;
          error.transient = response.status === 429 || response.status >= 500;
          throw error;
        }
        return {
          ok: true,
          metric: request.metric,
          status: response.status,
          data: body,
          nextPageToken: body.nextPageToken ?? null,
          message: null,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
```

- [ ] **Step 5: Point the old gateway at the shared validator**

In `lib/jobs/google-health-gateway.js`, delete the local `OPERATIONS`, `COMBINATIONS`, `DATE_PATTERN` constants and the `validate` function, and replace the call site:

```js
import { validateGoogleHealthRequest } from './google-health-request.js';
// ...
    async request(request) {
      validateGoogleHealthRequest(request);
```

Leave everything else in that file alone — it is still the production path until Task 9.

- [ ] **Step 6: Run tests**

Run: `node --test test/google-health-client.test.js && npm test`
Expected: PASS, including the existing gateway assertions in `test/sync.test.js`.

- [ ] **Step 7: Commit**

```bash
git add lib/jobs/google-health-request.js lib/jobs/google-health-client.js lib/jobs/google-health-gateway.js test/google-health-client.test.js
git commit -m "feat: call Google Health directly behind the gateway contract"
```

---

## Task 6: Connector HTTP surface

**Files:**
- Create: `lib/routes/connector-routes.js`
- Modify: `lib/auth.js`, `server.js`, `.env.example`
- Test: `test/connector-routes.test.js`

**Interfaces:**
- Produces: `createConnectorRouter({ connector, oauth, secret, requireAuth, now })` mounted at `/api/connectors`:
  - `GET /google` → `{ ok: true, data: <connector.status()> }`
  - `POST /google/authorize` → `{ ok: true, data: { url } }`
  - `GET /google/callback?code=&state=` → 302 to `/settings?connected=1`, or `/settings?error=...`
  - `POST /google/disconnect` → `{ ok: true }`

**Required change to `lib/auth.js`:** the session cookie is currently `sameSite: 'strict'`. A strict cookie is **not sent** on the top-level cross-site redirect back from `accounts.google.com`, so `requireAuth` would bounce the callback to `/login` and the flow could never complete. Change `sameSite` to `'lax'`. This remains safe: `validateMutationOrigin` in `lib/http/security.js:24` already rejects cross-origin mutations, and `lax` still withholds the cookie from cross-site POSTs.

- [ ] **Step 1: Write the failing test**

Create `test/connector-routes.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createConnectorRouter } from '../lib/routes/connector-routes.js';
import { signState } from '../lib/connectors/google-oauth.js';

const SECRET = 'test-secret-value';

function createServer({ connector, oauth }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/connectors',
    createConnectorRouter({
      connector,
      oauth,
      secret: SECRET,
      requireAuth: (_req, _res, next) => next(),
    }),
  );
  return app.listen(0);
}

async function call(server, path, options) {
  const { port } = server.address();
  return fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', ...options });
}

test('status never leaks a token', async () => {
  const server = createServer({
    connector: {
      async status() {
        return { connected: true, email: 'owner@example.com', scope: 'a', lastError: null };
      },
    },
    oauth: {},
  });
  const response = await call(server, '/api/connectors/google');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.connected, true);
  assert.ok(!JSON.stringify(body).toLowerCase().includes('token'));
  server.close();
});

test('authorize returns a signed-state url', async () => {
  const server = createServer({
    connector: {},
    oauth: { authorizationUrl: ({ state }) => `https://accounts.google.com/x?state=${state}` },
  });
  const response = await call(server, '/api/connectors/google/authorize', { method: 'POST' });
  const body = await response.json();
  assert.match(body.data.url, /^https:\/\/accounts\.google\.com\/x\?state=/);
  server.close();
});

test('the callback rejects a forged state without exchanging anything', async () => {
  let exchanges = 0;
  const server = createServer({
    connector: { async connectWithCode() { exchanges += 1; } },
    oauth: {},
  });
  const response = await call(server, '/api/connectors/google/callback?code=c&state=forged');
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /error=invalid_state/);
  assert.equal(exchanges, 0);
  server.close();
});

test('the callback stores tokens for a valid state', async () => {
  let code = null;
  const server = createServer({
    connector: { async connectWithCode(value) { code = value; } },
    oauth: {},
  });
  const state = signState(SECRET, {});
  const response = await call(
    server,
    `/api/connectors/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/settings?connected=1');
  assert.equal(code, 'auth-code');
  server.close();
});

test('the callback surfaces a denied consent', async () => {
  const server = createServer({ connector: {}, oauth: {} });
  const state = signState(SECRET, {});
  const response = await call(
    server,
    `/api/connectors/google/callback?error=access_denied&state=${encodeURIComponent(state)}`,
  );
  assert.match(response.headers.get('location'), /error=access_denied/);
  server.close();
});

test('disconnect delegates to the connector', async () => {
  let called = false;
  const server = createServer({
    connector: { async disconnect() { called = true; } },
    oauth: {},
  });
  const response = await call(server, '/api/connectors/google/disconnect', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(called, true);
  server.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connector-routes.test.js`
Expected: FAIL — cannot find module `../lib/routes/connector-routes.js`.

- [ ] **Step 3: Implement the router**

Create `lib/routes/connector-routes.js`:

```js
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
```

- [ ] **Step 4: Relax the session cookie**

In `lib/auth.js`, inside `advanced.defaultCookieAttributes`, change:

```js
        sameSite: 'lax',
```

Add a comment above it:

```js
        // `lax` rather than `strict`: the Google OAuth callback is a top-level
        // cross-site redirect, and a strict cookie would not be sent with it.
        // Cross-origin mutations remain blocked by validateMutationOrigin.
```

- [ ] **Step 5: Wire it into the server**

In `server.js`, add imports and construction. Inside `createApp`, after the sync router block, add:

```js
  if (connector && oauth) {
    app.use(
      '/api/connectors',
      createConnectorRouter({
        connector,
        oauth,
        secret: env.DASHBOARD_SESSION_SECRET || '',
        requireAuth,
      }),
    );
  }
```

Accept `connector = null` and `oauth = null` in the `createApp` options destructuring alongside `syncService` and `exportService`. Add `/settings` to the authenticated HTML routes:

```js
  app.get(['/', '/index.html', '/settings'], requireAuth, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });
```

- [ ] **Step 6: Document the configuration**

Append to `.env.example`:

```
# Owned Google Health connector. Same OAuth client as the retired n8n credential.
GOOGLE_CONNECTOR_MODE=n8n
GOOGLE_OAUTH_CLIENT_ID=replace-with-the-google-cloud-oauth-client-id
GOOGLE_OAUTH_CLIENT_SECRET=replace-with-the-google-cloud-oauth-client-secret
GOOGLE_OAUTH_REDIRECT_URI=https://fitbit.philippeho.dev/api/connectors/google/callback
# Comma-separated versioned AES-256-GCM keys: version:base64-encoded-32-byte-key.
CONNECTOR_ENCRYPTION_KEYS=1:replace-with-a-base64-encoded-32-byte-key
```

- [ ] **Step 7: Run tests**

Run: `node --test test/connector-routes.test.js && npm test`
Expected: PASS. `test/server.test.js` and `test/api.test.js` must still pass — the `sameSite` change may be asserted there; if so, update those assertions to `lax` and note the reason in the commit body.

- [ ] **Step 8: Commit**

```bash
git add lib/routes/connector-routes.js lib/auth.js server.js .env.example test/connector-routes.test.js
git commit -m "feat: expose the Google connector over HTTP"
```

---

## Task 7: Settings view and staleness banner

**Files:**
- Create: `public/settings-ui.js`
- Modify: `public/index.html`, `public/app.js`, `lib/db/health-repository.js`
- Test: `test/connector-ui.test.js`

**Interfaces:**
- Consumes: `GET /api/connectors/google`, `POST /api/connectors/google/authorize`, `POST /api/connectors/google/disconnect`.
- Produces: `renderConnectorStatus(document, status)` and `connectorBannerMessage(status, { newestMeasurementAt, now })` → string or `null`, both exported from `public/settings-ui.js` so they can be tested without a browser (follow the existing pattern in `public/health-ui.js` and `test/health-ui.test.js`).

- [ ] **Step 1: Write the failing test**

Create `test/connector-ui.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { connectorBannerMessage } from '../public/settings-ui.js';

const NOW = Date.parse('2026-09-04T17:00:00Z');

test('no banner when connected and data is fresh', () => {
  assert.equal(
    connectorBannerMessage(
      { connected: true },
      { newestMeasurementAt: '2026-09-04T06:00:00Z', now: NOW },
    ),
    null,
  );
});

test('banner when disconnected', () => {
  const message = connectorBannerMessage(
    { connected: false, lastError: 'invalid_grant' },
    { newestMeasurementAt: '2026-09-04T06:00:00Z', now: NOW },
  );
  assert.match(message, /reconnect/i);
});

test('banner when data is stale despite a live connection', () => {
  const message = connectorBannerMessage(
    { connected: true },
    { newestMeasurementAt: '2026-08-01T06:00:00Z', now: NOW },
  );
  assert.match(message, /34 days/);
});

test('banner when nothing has ever synced', () => {
  assert.ok(
    connectorBannerMessage({ connected: true }, { newestMeasurementAt: null, now: NOW }),
  );
});

test('36 hours is the staleness boundary', () => {
  const fresh = new Date(NOW - 35 * 60 * 60 * 1000).toISOString();
  const stale = new Date(NOW - 37 * 60 * 60 * 1000).toISOString();
  assert.equal(connectorBannerMessage({ connected: true }, { newestMeasurementAt: fresh, now: NOW }), null);
  assert.ok(connectorBannerMessage({ connected: true }, { newestMeasurementAt: stale, now: NOW }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connector-ui.test.js`
Expected: FAIL — cannot find module `../public/settings-ui.js`.

- [ ] **Step 3: Implement the banner logic**

Create `public/settings-ui.js`:

```js
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export function connectorBannerMessage(status, { newestMeasurementAt, now = Date.now() } = {}) {
  if (!status || status.connected !== true) {
    return 'Google Health is disconnected. Open Settings to reconnect — this takes about twenty seconds.';
  }
  if (!newestMeasurementAt) {
    return 'Google Health is connected but nothing has synced yet.';
  }
  const age = now - Date.parse(newestMeasurementAt);
  if (!Number.isFinite(age) || age <= STALE_AFTER_MS) return null;
  const days = Math.floor(age / 86_400_000);
  const detail = days >= 1 ? `${days} days` : `${Math.floor(age / 3_600_000)} hours`;
  return `The newest health data is ${detail} old. Check Settings for the connection state.`;
}

export function renderConnectorStatus(document, status) {
  const state = document.getElementById('connectorState');
  const detail = document.getElementById('connectorDetail');
  const button = document.getElementById('connectorConnect');
  if (!state || !detail || !button) return;
  state.textContent = status.connected ? 'Connected' : 'Disconnected';
  state.dataset.state = status.connected ? 'connected' : 'disconnected';
  detail.textContent = status.connected
    ? `${status.email || 'Google account'} · token expires ${
        status.accessTokenExpiresAt
          ? new Date(status.accessTokenExpiresAt).toLocaleString()
          : 'unknown'
      }`
    : status.lastError || 'Not connected';
  button.textContent = status.connected ? 'Reconnect' : 'Connect Google Health';
}
```

- [ ] **Step 4: Add the settings view markup**

In `public/index.html`, add a nav entry inside `<nav class="main-nav">` (line 34) matching the existing button pattern, with `data-view="settings"`. Then add a view section alongside the others:

```html
<section id="view-settings" class="app-view" data-view="settings" hidden>
  <header class="view-header">
    <h1>Settings</h1>
    <p>Connections and account.</p>
  </header>
  <section class="metric-panel" aria-labelledby="connectorHeading">
    <h2 id="connectorHeading">Google Health</h2>
    <p><span id="connectorState" class="sync-status" data-state="disconnected">Unknown</span></p>
    <p id="connectorDetail" class="metric-empty"></p>
    <p class="metric-empty">
      This connection expires every 7 days because the Google app is unverified.
      Reconnecting takes about twenty seconds.
    </p>
    <button id="connectorConnect" class="button button-primary" type="button">Connect Google Health</button>
    <button id="connectorDisconnect" class="button button-secondary" type="button">Disconnect</button>
  </section>
</section>
```

Add the banner element directly after `#notice` (line 59):

```html
<div id="connectorBanner" class="notice" role="alert" hidden></div>
```

- [ ] **Step 5: Wire the view into `public/app.js`**

Import the helpers at the top of `public/app.js`:

```js
import { connectorBannerMessage, renderConnectorStatus } from './settings-ui.js';
```

Add a loader that runs on startup and after every sync completes:

```js
async function refreshConnector() {
  const response = await fetch('/api/connectors/google', { credentials: 'same-origin' });
  if (!response.ok) return;
  const { data } = await response.json();
  renderConnectorStatus(document, data);
  const banner = document.getElementById('connectorBanner');
  const message = connectorBannerMessage(data, {
    newestMeasurementAt: state.newestMeasurementAt ?? null,
  });
  banner.textContent = message ?? '';
  banner.hidden = !message;
}
```

Wire the two buttons:

```js
document.getElementById('connectorConnect')?.addEventListener('click', async () => {
  const response = await fetch('/api/connectors/google/authorize', {
    method: 'POST',
    credentials: 'same-origin',
  });
  const { data } = await response.json();
  window.location.href = data.url;
});

document.getElementById('connectorDisconnect')?.addEventListener('click', async () => {
  await fetch('/api/connectors/google/disconnect', {
    method: 'POST',
    credentials: 'same-origin',
  });
  await refreshConnector();
});
```

`state.newestMeasurementAt` must be populated from the dashboard payload. In `lib/db/health-repository.js`, add a `newestMeasurementAt` field to the object returned by `getDashboard(date)`, computed as the greatest of the newest `heart_rate_samples.sampled_at`, `sleep_sessions.start_time`, and `calorie_intervals` start timestamp for the account. Add a matching assertion to `test/health-repository.test.js`.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS, including `test/responsive-css.test.js` and `test/health-ui.test.js`.

- [ ] **Step 7: Commit**

```bash
git add public/settings-ui.js public/index.html public/app.js lib/db/health-repository.js test/connector-ui.test.js test/health-repository.test.js
git commit -m "feat: show connector health in the dashboard"
```

---

## Task 8: Disconnection alerting

**Files:**
- Create: `lib/connectors/alerts.js`
- Modify: `server.js`, `.env.example`
- Test: `test/connector-alerts.test.js`

**Interfaces:**
- Produces: `createConnectorAlerter({ url, token, publicOrigin, fetchImpl, logger })` → `async notifyDisconnected(message)`. Never throws; a failed alert is logged and swallowed so it can never break sync.
- Consumed by: `createGoogleConnector({ onDisconnect })` from Task 4, which already fires exactly once on the connected→disconnected edge.

- [ ] **Step 1: Write the failing test**

Create `test/connector-alerts.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createConnectorAlerter } from '../lib/connectors/alerts.js';

test('posts a reconnect link with the shared token', async () => {
  let seen = null;
  const alerter = createConnectorAlerter({
    url: 'https://n8n.example.com/webhook/alert',
    token: 'shared-token',
    publicOrigin: 'https://fitbit.example.com',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200 };
    },
  });
  await alerter.notifyDisconnected('invalid_grant: Bad Request');
  assert.equal(seen.url, 'https://n8n.example.com/webhook/alert');
  assert.equal(seen.options.headers['x-fitness-token'], 'shared-token');
  const body = JSON.parse(seen.options.body);
  assert.match(body.text, /invalid_grant/);
  assert.equal(body.reconnectUrl, 'https://fitbit.example.com/settings');
});

test('a failing webhook never throws', async () => {
  const logged = [];
  const alerter = createConnectorAlerter({
    url: 'https://n8n.example.com/webhook/alert',
    token: 't',
    publicOrigin: 'https://fitbit.example.com',
    fetchImpl: async () => {
      throw new Error('network down');
    },
    logger: { error: (message) => logged.push(message) },
  });
  await alerter.notifyDisconnected('invalid_grant');
  assert.equal(logged.length, 1);
});

test('an unconfigured alerter is a no-op', async () => {
  const alerter = createConnectorAlerter({
    url: '',
    token: '',
    publicOrigin: '',
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });
  await alerter.notifyDisconnected('invalid_grant');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connector-alerts.test.js`
Expected: FAIL — cannot find module `../lib/connectors/alerts.js`.

- [ ] **Step 3: Implement**

Create `lib/connectors/alerts.js`:

```js
export function createConnectorAlerter({
  url,
  token,
  publicOrigin,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  return {
    async notifyDisconnected(message) {
      if (!url || !token) return;
      const origin = String(publicOrigin || '').split(',')[0].trim();
      try {
        await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fitness-token': token },
          body: JSON.stringify({
            source: 'health-hub-connector',
            severity: 'warning',
            text: `Google Health disconnected: ${message}. Reconnect to resume syncing.`,
            reconnectUrl: `${origin}/settings`,
            occurredAt: new Date().toISOString(),
          }),
        });
      } catch (error) {
        logger.error('Connector alert could not be delivered', { message: error.message });
      }
    },
  };
}
```

- [ ] **Step 4: Wire it in `server.js`**

In the `isDirectRun` block, build the alerter and pass its callback into the connector:

```js
  const connectorAlerter = createConnectorAlerter({
    url: process.env.CONNECTOR_ALERT_WEBHOOK_URL || '',
    token: process.env.CONNECTOR_ALERT_WEBHOOK_TOKEN || '',
    publicOrigin: process.env.PUBLIC_ORIGIN || '',
  });
```

and pass `onDisconnect: (message) => connectorAlerter.notifyDisconnected(message)` to `createGoogleConnector`.

Append to `.env.example`:

```
# Outbound connector alerts, delivered by n8n to Telegram. Optional.
CONNECTOR_ALERT_WEBHOOK_URL=
CONNECTOR_ALERT_WEBHOOK_TOKEN=
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/connectors/alerts.js server.js .env.example test/connector-alerts.test.js
git commit -m "feat: alert when the Google connector disconnects"
```

---

## Task 9: Cutover and backfill

Everything before this is inert in production because `GOOGLE_CONNECTOR_MODE` defaults to `n8n`. This task wires the mode switch, then performs the live cutover.

**Files:**
- Create: `scripts/sync-backfill.mjs`
- Modify: `server.js`, `README.md`, `docs/hetzner-promotion.md`
- Test: `test/connector-mode.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/connector-mode.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { selectGoogleHealthGateway } from '../server.js';

test('defaults to the n8n gateway', () => {
  const chosen = selectGoogleHealthGateway({
    env: {},
    n8nGateway: { name: 'n8n' },
    directClient: { name: 'direct' },
  });
  assert.equal(chosen.name, 'n8n');
});

test('selects the direct client when asked', () => {
  const chosen = selectGoogleHealthGateway({
    env: { GOOGLE_CONNECTOR_MODE: 'direct' },
    n8nGateway: { name: 'n8n' },
    directClient: { name: 'direct' },
  });
  assert.equal(chosen.name, 'direct');
});

test('falls back to n8n when direct is requested but unavailable', () => {
  const chosen = selectGoogleHealthGateway({
    env: { GOOGLE_CONNECTOR_MODE: 'direct' },
    n8nGateway: { name: 'n8n' },
    directClient: null,
  });
  assert.equal(chosen.name, 'n8n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/connector-mode.test.js`
Expected: FAIL — `selectGoogleHealthGateway` is not exported.

- [ ] **Step 3: Implement the selector**

Add to `server.js`, exported alongside `createApp`:

```js
export function selectGoogleHealthGateway({ env = process.env, n8nGateway, directClient }) {
  if (env.GOOGLE_CONNECTOR_MODE === 'direct' && directClient) return directClient;
  return n8nGateway;
}
```

In the `isDirectRun` block, construct the connector and direct client when
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `CONNECTOR_ENCRYPTION_KEYS`
are all present, then pass `selectGoogleHealthGateway({ ... })` as the `gateway` option to
`createSyncService`. When any are absent, `directClient` is `null` and the n8n gateway is used.

- [ ] **Step 4: Write the backfill script**

Create `scripts/sync-backfill.mjs`:

```js
import 'dotenv/config';

import { createPool } from '../lib/db/pool.js';
import { createSyncRepository } from '../lib/jobs/sync-repository.js';
import { createSyncService } from '../lib/jobs/sync-service.js';
import { createMetricWriter } from '../lib/db/metric-writer.js';
import { buildGatewayFromEnv } from './connector-support.mjs';

const [, , startDate, endDateExclusive] = process.argv;
if (!startDate || !endDateExclusive) {
  console.error('Usage: node scripts/sync-backfill.mjs <start-date> <end-date-exclusive>');
  process.exit(1);
}

const pool = createPool();
const service = createSyncService({
  pool,
  repository: createSyncRepository(pool),
  gateway: await buildGatewayFromEnv(pool),
  writer: createMetricWriter(pool, {
    compactWritesEnabled: process.env.HEALTH_COMPACT_WRITES_ENABLED === 'true',
  }),
  rawRetentionDays: Number(process.env.RAW_RETENTION_DAYS) || null,
});

const job = await service.enqueue({
  mode: 'backfill',
  startDate,
  endDateExclusive,
  requestedBy: 'operator-backfill',
});
console.log(`Enqueued backfill job ${job.id} covering ${startDate} to ${endDateExclusive}`);
await pool.end();
```

Extract the shared gateway construction used by both `server.js` and this script into
`scripts/connector-support.mjs` exporting `buildGatewayFromEnv(pool)`, so the two paths
cannot drift.

Add to `package.json` scripts:

```json
    "sync:backfill": "node scripts/sync-backfill.mjs",
```

- [ ] **Step 5: Run tests and commit**

```bash
npm test
git add server.js scripts/sync-backfill.mjs scripts/connector-support.mjs package.json test/connector-mode.test.js
git commit -m "feat: select the Google gateway by connector mode"
```

- [ ] **Step 6: Owner action — register the redirect URI**

**STOP. This step needs the repository owner.**

In Google Cloud Console → **Google Auth Platform → Clients** → the existing OAuth client,
add to *Authorized redirect URIs*:

```
https://fitbit.philippeho.dev/api/connectors/google/callback
http://localhost:3000/api/connectors/google/callback
```

Save. Then in Coolify, add to the application environment:

- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` — the same values the n8n
  credential uses
- `GOOGLE_OAUTH_REDIRECT_URI=https://fitbit.philippeho.dev/api/connectors/google/callback`
- `CONNECTOR_ENCRYPTION_KEYS=1:<new base64 32-byte key>`, generated with
  `node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"`
- Leave `GOOGLE_CONNECTOR_MODE` unset for now.

- [ ] **Step 7: Deploy and connect**

Deploy, confirm `GET /readyz` returns 200, sign in, open `/settings`, and click
**Connect Google Health**. Expect the unverified-app interstitial — *Advanced → Go to
FitbitHealthTracker (unsafe)*. Confirm the settings page then reads **Connected**.

- [ ] **Step 8: Cut over**

Set `GOOGLE_CONNECTOR_MODE=direct` in Coolify and redeploy. Traefik returns 503 for
roughly 30–60 seconds while the container is recreated; poll rather than concluding
failure. Then trigger a one-day sync from the dashboard and confirm a `completed` job in
`sync_jobs`.

- [ ] **Step 9: Backfill the gap**

```bash
docker exec <app-container> node scripts/sync-backfill.mjs 2026-07-25 <tomorrow>
```

Raw metrics are clamped to the 90-day retention window automatically by
`sync-service.enqueue`; sleep and daily resting heart rate backfill fully. Verify with:

```sql
SELECT max(sampled_at) FROM heart_rate_samples;
SELECT max(start_time) FROM sleep_sessions;
SELECT status, count(*) FROM sync_chunks GROUP BY status;
```

- [ ] **Step 10: Document and commit**

Update `README.md` and `docs/hetzner-promotion.md` to describe the owned connector, the
weekly reconnect, and the `GOOGLE_CONNECTOR_MODE` rollback switch.

```bash
git add README.md docs/hetzner-promotion.md
git commit -m "docs: describe the owned Google Health connector"
```

---

## Task 10: SpO2 metrics

Additive. Do not start until Task 9 shows a `completed` sync in direct mode.

**Files:**
- Create: `db/migrations/008_oxygen_saturation.sql`
- Modify: `lib/jobs/planner.js`, `lib/jobs/google-health-request.js`, `lib/metrics/normalizers.js`, `lib/db/metric-writer.js`, `lib/jobs/sync-service.js`, `lib/db/health-repository.js`, `public/index.html`, `public/app.js`
- Test: `test/oxygen-saturation.test.js`

**Interfaces:**
- Produces: `normalizeOxygenSaturationSamples(payload)` → array of
  `{ providerKey, providerId, civilDate, sampledAt, utcOffsetSeconds, percentage, device, sourceMetadata, sourceFields }`;
  `normalizeDailyOxygenSaturation(payload)` → array of
  `{ civilDate, averagePercentage, minimumPercentage, maximumPercentage, sourceFields }`;
  `writer.upsertOxygenSaturationSamples(sourceAccountId, samples)` and
  `writer.upsertDailyOxygenSaturation(sourceAccountId, summaries)`.

- [ ] **Step 1: Capture a real response first**

Before writing the normalizer, confirm the live payload shape. With the connector
connected, run inside the app container:

```bash
node -e "
import('./scripts/connector-support.mjs').then(async ({ buildGatewayFromEnv }) => {
  const { createPool } = await import('./lib/db/pool.js');
  const pool = createPool();
  const gateway = await buildGatewayFromEnv(pool);
  const result = await gateway.request({
    operation: 'list', metric: 'oxygen-saturation',
    startDate: '2026-09-01', endDateExclusive: '2026-09-04',
  });
  console.log(JSON.stringify(result.data, null, 2).slice(0, 4000));
  await pool.end();
});
"
```

Save a trimmed copy as `test/fixtures/oxygen-saturation.json`. If the field names differ
from the assumptions below, adjust the normalizer and its test to match the real payload —
the fixture is authoritative, not this plan.

- [ ] **Step 2: Write the failing test**

Create `test/oxygen-saturation.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeDailyOxygenSaturation,
  normalizeOxygenSaturationSamples,
} from '../lib/metrics/normalizers.js';
import { buildGoogleHealthRequest } from '../lib/jobs/google-health-request.js';
import { GOOGLE_HEALTH_METRICS, planMetricWindows } from '../lib/jobs/planner.js';

test('both SpO2 metrics are planned as list operations', () => {
  assert.ok(GOOGLE_HEALTH_METRICS.includes('oxygen-saturation'));
  assert.ok(GOOGLE_HEALTH_METRICS.includes('daily-oxygen-saturation'));
  const windows = planMetricWindows({
    metric: 'daily-oxygen-saturation',
    startDate: '2026-06-01',
    endDateExclusive: '2026-09-01',
  });
  assert.ok(windows.length >= 1);
  assert.equal(windows[0].operation, 'list');
});

test('builds the documented SpO2 filter fields', () => {
  const intraday = new URL(
    buildGoogleHealthRequest({
      operation: 'list',
      metric: 'oxygen-saturation',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    }).url,
  );
  assert.match(intraday.searchParams.get('filter'), /oxygen_saturation\.sample_time\.civil_time/);

  const daily = new URL(
    buildGoogleHealthRequest({
      operation: 'list',
      metric: 'daily-oxygen-saturation',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-02',
    }).url,
  );
  assert.match(daily.searchParams.get('filter'), /daily_oxygen_saturation\.date/);
});

test('normalizes intraday samples and drops impossible percentages', () => {
  const samples = normalizeOxygenSaturationSamples({
    dataPoints: [
      {
        dataPointName: 'users/me/dataPoints/one',
        oxygenSaturation: {
          percentage: 96.5,
          sampleTime: { physicalTime: '2026-09-03T04:12:00Z', utcOffset: '-14400s' },
        },
      },
      {
        dataPointName: 'users/me/dataPoints/two',
        oxygenSaturation: {
          percentage: 0,
          sampleTime: { physicalTime: '2026-09-03T04:13:00Z', utcOffset: '-14400s' },
        },
      },
      {
        dataPointName: 'users/me/dataPoints/three',
        oxygenSaturation: {
          percentage: 140,
          sampleTime: { physicalTime: '2026-09-03T04:14:00Z', utcOffset: '-14400s' },
        },
      },
    ],
  });
  assert.equal(samples.length, 1);
  assert.equal(samples[0].percentage, 96.5);
  assert.equal(samples[0].civilDate, '2026-09-03');
  assert.equal(samples[0].utcOffsetSeconds, -14400);
});

test('normalizes the daily summary', () => {
  const summaries = normalizeDailyOxygenSaturation({
    dataPoints: [
      {
        dailyOxygenSaturation: {
          date: { year: 2026, month: 9, day: 3 },
          averagePercentage: 95.2,
          minimumPercentage: 90.1,
          maximumPercentage: 99.0,
        },
      },
    ],
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].civilDate, '2026-09-03');
  assert.equal(summaries[0].averagePercentage, 95.2);
});

test('an empty payload normalizes to an empty array', () => {
  assert.deepEqual(normalizeOxygenSaturationSamples({}), []);
  assert.deepEqual(normalizeDailyOxygenSaturation({}), []);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/oxygen-saturation.test.js`
Expected: FAIL — `normalizeOxygenSaturationSamples` is not exported.

- [ ] **Step 4: Write the migration**

Create `db/migrations/008_oxygen_saturation.sql`:

```sql
CREATE TABLE oxygen_saturation_samples (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL,
  utc_offset_seconds integer NOT NULL DEFAULT 0,
  percentage numeric(5, 2) NOT NULL,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, provider_key)
);

CREATE INDEX oxygen_saturation_samples_date_idx
  ON oxygen_saturation_samples (source_account_id, civil_date, sampled_at);

CREATE TABLE oxygen_saturation_daily_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  civil_date date NOT NULL,
  average_percentage numeric(5, 2),
  minimum_percentage numeric(5, 2),
  maximum_percentage numeric(5, 2),
  sample_count integer NOT NULL DEFAULT 0,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, civil_date)
);
```

- [ ] **Step 5: Extend the planner**

In `lib/jobs/planner.js`:
- Append `'oxygen-saturation'` and `'daily-oxygen-saturation'` to `GOOGLE_HEALTH_METRICS`.
- Add `'oxygen-saturation'` to `RAW_SYNC_METRICS` (intraday samples are raw and must obey the 90-day retention clamp). Leave `daily-oxygen-saturation` out of it — daily summaries are permanent.
- Add to `WINDOW_DAYS`: `'oxygen-saturation': 14`, `'daily-oxygen-saturation': 90`.
- Add to `OPERATIONS`: both map to `'list'`.

`DEFAULT_SYNC_METRICS` derives from `GOOGLE_HEALTH_METRICS` by excluding `total-calories`, so both new metrics join the scheduled sync automatically.

- [ ] **Step 6: Extend the request builder**

In `lib/jobs/google-health-request.js`, add both metrics to `COMBINATIONS.list` and add to
`FILTER_FIELDS`:

```js
  'oxygen-saturation': 'oxygen_saturation.sample_time.civil_time',
  'daily-oxygen-saturation': 'daily_oxygen_saturation.date',
```

- [ ] **Step 7: Implement the normalizers**

Add to `lib/metrics/normalizers.js`, reusing the existing `points`, `numberOrNull`,
`offsetSeconds`, `civilDate`, `civilDateObject` and `hash` helpers already in that file:

```js
export function normalizeOxygenSaturationSamples(payload) {
  const normalized = new Map();
  for (const point of points(payload)) {
    const reading = point.oxygenSaturation ?? point;
    const sampleTime = reading.sampleTime;
    const sampledAt = sampleTime?.physicalTime ?? sampleTime ?? reading.time;
    const percentage = numberOrNull(reading.percentage ?? reading.value?.percentage);
    if (!sampledAt || percentage === null || percentage <= 0 || percentage > 100) continue;
    const utcOffset = sampleTime?.utcOffset ?? reading.utcOffset ?? null;
    const providerId = point.dataPointName ?? point.name ?? null;
    const providerKey = providerId
      ? `${providerId}:${sampledAt}`
      : hash(`spo2:${sampledAt}:${percentage}`);
    normalized.set(providerKey, {
      providerKey,
      providerId,
      civilDate: civilDate(sampledAt, utcOffset),
      sampledAt,
      utcOffsetSeconds: offsetSeconds(utcOffset),
      percentage,
      device: point.dataSource?.device ?? {},
      sourceMetadata: { dataType: 'oxygen-saturation', dataSource: point.dataSource ?? {} },
      sourceFields: point,
    });
  }
  return [...normalized.values()];
}

export function normalizeDailyOxygenSaturation(payload) {
  const normalized = new Map();
  for (const point of points(payload)) {
    const daily = point.dailyOxygenSaturation ?? point;
    const date = civilDateObject(daily.date);
    const averagePercentage = numberOrNull(daily.averagePercentage ?? daily.percentage);
    if (!date || averagePercentage === null) continue;
    normalized.set(date, {
      civilDate: date,
      averagePercentage,
      minimumPercentage: numberOrNull(daily.minimumPercentage),
      maximumPercentage: numberOrNull(daily.maximumPercentage),
      sourceFields: point,
    });
  }
  return [...normalized.values()];
}
```

- [ ] **Step 8: Extend the writer and the ingest branch**

Add `upsertOxygenSaturationSamples` and `upsertDailyOxygenSaturation` to
`lib/db/metric-writer.js`, following the batched set-based upsert already used by
`upsertHeartSamples` and `upsertRestingHeartRateDaily` — conflict targets are
`(source_account_id, provider_key)` and `(source_account_id, civil_date)` respectively.

In `lib/jobs/sync-service.js`, extend `ingest` with two branches before the calorie
fallback:

```js
    } else if (chunk.metric === 'oxygen-saturation') {
      const samples = normalizeOxygenSaturationSamples(data);
      await writer.upsertOxygenSaturationSamples(chunk.source_account_id, samples);
    } else if (chunk.metric === 'daily-oxygen-saturation') {
      const summaries = normalizeDailyOxygenSaturation(data);
      await writer.upsertDailyOxygenSaturation(chunk.source_account_id, summaries);
```

Import both normalizers at the top of the file.

- [ ] **Step 9: Surface SpO2 in the dashboard**

Add `oxygenSaturation` to the payload from `health-repository.getDashboard(date)` —
average, minimum, maximum and sample count for the date — and add a metric panel to
`public/index.html` matching the existing `compact-panel` heart and calorie panels, with
its rendering wired in `public/app.js`. Add an assertion to `test/health-repository.test.js`.

- [ ] **Step 10: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 11: Commit and backfill SpO2**

```bash
git add db/migrations/008_oxygen_saturation.sql lib/jobs/planner.js lib/jobs/google-health-request.js lib/metrics/normalizers.js lib/db/metric-writer.js lib/jobs/sync-service.js lib/db/health-repository.js public/index.html public/app.js test/oxygen-saturation.test.js test/health-repository.test.js
git commit -m "feat: archive Fitbit SpO2 readings"
```

Deploy, then backfill daily SpO2 history:

```bash
docker exec <app-container> node scripts/sync-backfill.mjs 2026-01-01 <tomorrow>
```

---

## Task 11: Retire the n8n health path

Only after direct mode has run cleanly for at least one full week — long enough to prove
the connector survives an expiry-and-reconnect cycle, which is the failure this whole
plan exists to handle.

**Files:**
- Delete: `n8n/health-hub-workflow.json`, `scripts/build-n8n-workflow.mjs`, `test/workflow.test.js`, `lib/jobs/google-health-gateway.js`
- Modify: `server.js`, `scripts/connector-support.mjs`, `package.json`, `.env.example`, `README.md`, `docs/hetzner-promotion.md`

- [ ] **Step 1: Confirm the precondition**

```sql
SELECT date_trunc('day', updated_at)::date AS day,
       count(*) FILTER (WHERE status = 'completed') AS ok,
       count(*) FILTER (WHERE status = 'failed') AS failed
FROM sync_chunks
WHERE updated_at > CURRENT_DATE - INTERVAL '8 days'
GROUP BY 1 ORDER BY 1;
```

Every day must show successes. Confirm at least one reconnect happened in that window.
If not, stop and wait.

- [ ] **Step 2: Remove the code**

```bash
git rm n8n/health-hub-workflow.json scripts/build-n8n-workflow.mjs test/workflow.test.js lib/jobs/google-health-gateway.js
```

Remove `selectGoogleHealthGateway` and the `GOOGLE_CONNECTOR_MODE` branch from
`server.js` and `scripts/connector-support.mjs` — the direct client becomes the only
path. Remove `test/connector-mode.test.js`. Remove the `build:workflow` script from
`package.json`, and `N8N_WEBHOOK_URL` / `N8N_WEBHOOK_TOKEN` from `.env.example`.

Keep `CONNECTOR_ALERT_WEBHOOK_URL` — n8n still delivers alerts.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS. Check `.github/workflows/ci.yml` for a `build:workflow` invocation and
remove it if present.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: retire the n8n Google Health gateway"
```

- [ ] **Step 5: Clean up the deployment**

Remove `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_TOKEN` and `GOOGLE_CONNECTOR_MODE` from Coolify.
In n8n, deactivate the `health-hub-sync` workflow but do not delete it for one further
month. Update `README.md` and `docs/hetzner-promotion.md` to describe the final
architecture.

---

## Notes for the executor

1. **Tasks 1–8 are inert in production.** `GOOGLE_CONNECTOR_MODE` defaults to `n8n`, so
   nothing changes for the live sync until Task 9 Step 8. Work freely.
2. **Task 4 is the one to be careful with.** The `refreshes === 1` assertion under eight
   concurrent callers is the entire point. If it is hard to satisfy, that is the design
   telling you something — do not weaken the test.
3. **Task 6 Step 4 is easy to miss.** Without the `sameSite` change the OAuth callback
   silently redirects to `/login` and the flow can never complete. The symptom looks like
   a Google problem and is not.
4. **Task 10 Step 1 comes before the normalizer.** The SpO2 field names in this plan are
   taken from Google's published documentation, not from a live response. Capture the
   fixture first and let it overrule this document.
5. **Two steps need the owner and cannot be done by an agent:** Task 9 Step 6 (redirect
   URI and secrets) and Step 7 (clicking through Google consent). Stop and ask.
