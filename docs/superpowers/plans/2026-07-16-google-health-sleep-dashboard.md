# Google Health Sleep Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a private seven-night Google Health sleep dashboard backed by the existing n8n webhook.

**Architecture:** Express provides password/session authentication and a protected `/api/sleep` proxy. n8n uses a dedicated Google OAuth credential to fetch Google Health identity and reconciled sleep sessions, then emits a UI-focused contract. The static Tailwind dashboard renders that contract without a client framework.

**Tech Stack:** Node.js 20+, Express 4, Node test runner, Tailwind CSS 3, n8n 2.30.4, Google Health REST API v4, Coolify.

## Global Constraints

- Preserve workflow ID `fitbitTracker001` and webhook path `fitness-sync`.
- Keep secrets out of git and browser-visible responses.
- Fetch live data only; do not add persistence or scheduling.
- Use Google Health API, not legacy Fitbit Web API or Google Fit API.
- Treat missing sleep/stage data as a valid empty or partial response.

---

### Task 1: Session authentication and protected server routes

**Files:**
- Create: `lib/session.js`
- Create: `test/session.test.js`
- Create: `test/server.test.js`
- Modify: `server.js`
- Modify: `package.json`

**Interfaces:**
- Produces: `createSessionToken(secret, nowMs, ttlMs)`, `verifySessionToken(token, secret, nowMs)`, `readCookie(header, name)`.
- Produces: `createApp({ env, fetchImpl })` for production and integration tests.

- [ ] Write failing tests for valid, tampered, and expired session tokens.
- [ ] Run `npm test -- test/session.test.js` and verify the missing module failure.
- [ ] Implement HMAC-SHA256 session tokens with timing-safe signature comparison.
- [ ] Run the session tests and verify they pass.
- [ ] Write failing integration tests proving `/` redirects to `/login`, bad login is rejected, valid login sets an `HttpOnly` cookie, `/api/sleep` requires the cookie, and the authenticated proxy sends `x-fitness-token`.
- [ ] Refactor `server.js` into an exported app factory with login/logout/session routes, protected dashboard/API routes, no-store headers, and production startup.
- [ ] Run all tests and commit `feat: add private dashboard sessions`.

### Task 2: Google Health sleep normalization contract

**Files:**
- Create: `lib/sleep-normalizer.js`
- Create: `test/sleep-normalizer.test.js`

**Interfaces:**
- Consumes: Google Health reconciled `dataPoints[]`.
- Produces: `normalizeSleepResponse({ dataPoints, startDate, endDateExclusive, generatedAt })`.
- Output: `{ latest, nights, naps, summary }`, with numeric minute fields and lower-case stage keys.

- [ ] Write failing tests for staged sleep, classic sleep, duplicate records on one date, naps, timezone offsets, and empty results.
- [ ] Run `npm test -- test/sleep-normalizer.test.js` and verify the missing module failure.
- [ ] Implement date derivation from civil end time or physical time plus UTC offset, record normalization, main-sleep selection, sorting, and seven-night averages.
- [ ] Run all normalization tests and commit `feat: normalize Google Health sleep data`.

### Task 3: Sleep dashboard interface

**Files:**
- Create: `public/login.html`
- Create: `public/login.js`
- Create: `public/sleep-ui.js`
- Create: `test/sleep-ui.test.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `src/input.css`

**Interfaces:**
- Consumes: `{ ok, elapsedMs, data: { latest, nights, naps, summary, sections } }`.
- Produces: accessible latest-night metrics, stage timeline, seven-night chart/history, loading/empty/error states, and diagnostics.

- [ ] Write failing pure-helper tests for duration formatting, stage percentages, timeline widths, and week-chart scaling.
- [ ] Run `npm test -- test/sleep-ui.test.js` and verify the missing exports.
- [ ] Implement the tested UI helpers as a browser-compatible ES module.
- [ ] Replace the connectivity prototype with the sleep dashboard and add the password login page.
- [ ] Add restrained product styling, skeleton loading, responsive behavior, visible focus states, and reduced-motion handling.
- [ ] Run `npm test` and `npm run build`; commit `feat: build sleep dashboard UI`.

### Task 4: n8n Google Health workflow

**Files:**
- Modify: `n8n/fitness-workflow.json`
- Create: `test/workflow.test.js`

**Interfaces:**
- Webhook remains `POST /webhook/fitness-sync`.
- Google OAuth scope: `https://www.googleapis.com/auth/googlehealth.sleep.readonly`.
- Google endpoints: `GET /v4/users/me/identity` and `GET /v4/users/me/dataTypes/sleep/dataPoints:reconcile`.

- [ ] Write a failing workflow-structure test asserting the stable ID/path, Header Auth, Google Health URLs, query filter, dedicated credential reference, and response node.
- [ ] Replace Google Fit nodes with Prep, Google Health Identity, Google Health Sleep, Normalize Sleep, and Respond nodes.
- [ ] Embed normalization logic equivalent to `lib/sleep-normalizer.js` in the n8n Code node and preserve full-response partial-failure reporting.
- [ ] Run workflow tests and JSON parsing; commit `feat: fetch Google Health sleep in n8n`.

### Task 5: Configuration, deployment, and live verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `Dockerfile` if runtime files require copying.

**Interfaces:**
- Required app env: `DASHBOARD_PASSWORD`, `DASHBOARD_SESSION_SECRET`, `N8N_WEBHOOK_URL`, `N8N_WEBHOOK_TOKEN`.
- Required n8n credential scope: Google Health sleep readonly.

- [ ] Document Google Health API enablement, OAuth test user/scope, n8n reconnect, webhook Header Auth, local test URL, and Coolify env.
- [ ] Generate non-printed production session/webhook secrets and configure Coolify/n8n.
- [ ] Back up n8n SQLite, publish the updated workflow through a supported CLI/API path, and confirm it remains active.
- [ ] Enable Google Health API and reconnect the dedicated n8n Google credential with the new scope; pause only if browser consent is required.
- [ ] Run `npm test`, `npm run build`, and `docker build`.
- [ ] Deploy the branch through Coolify, verify `/healthz`, unauthorized access, login, and a real seven-night sync.
- [ ] Commit `docs: document Google Health sleep deployment`.

