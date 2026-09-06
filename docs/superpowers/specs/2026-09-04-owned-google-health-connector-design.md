# Owned Google Health Connector — Design

Date: 2026-09-04
Status: Approved for implementation
Supersedes the n8n-mediated Google Health gateway for the sync path only.

## Problem

On 2026-09-04 the dashboard had been showing stale data for 42 days. Investigation
established:

- Last successful sync chunk: `2026-07-24 18:15 UTC`. First failure: `2026-07-25`.
- Every one of the 830 failed `sync_chunks` rows since carries the same n8n error:
  `The credential "Google account" needs to be reconnected.`
- A direct refresh-token grant against `https://oauth2.googleapis.com/token` returns
  `HTTP 400 invalid_grant`.
- No code shipped on 2026-07-24. The Better Auth refactor landed 2026-09-03/04, six
  weeks *after* the break, and is not implicated. `npm test` passes, `/readyz` returns
  200, and a user-requested sync enqueued successfully through `requireAuth` on
  2026-09-04.

Root cause: the Google Cloud project `FitbitPhil` has OAuth publishing status
**Testing** with user type **External**. Google expires refresh tokens issued by such
apps after exactly 7 days. The archive begins 2026-07-18 and died 2026-07-25 — one
7-day window.

The secondary and more serious defect: **the failure was silent for 42 days.**
`/readyz` stayed green, the UI showed stale numbers without comment, and the errors
accumulated only in `sync_jobs.error_message`.

## Constraints that cannot be changed

1. **The 7-day expiry is permanent.** The Google Health scopes in use are classified
   *restricted*, not merely sensitive. Publishing to production requires full
   verification plus a CASA third-party security assessment, paid, and renewed every
   12 months. Not viable for a single-user personal archive. The app stays in Testing
   and the token will keep dying weekly.
2. **Internal user type is unavailable.** It removes the expiry, but restricts consent
   to members of a Google Workspace organization. The health data belongs to
   `philippeho27@gmail.com` and the Fitbit Air is paired to it.
3. **The Fitbit Web API is not an escape hatch.** It shuts down 2026-09-30. The Google
   Health API is its replacement; this project is already on the correct API.
4. **Health Connect is not an escape hatch.** It is Android-only; the owner uses iOS.

## Decision

Stop trying to eliminate the weekly reconnect. Eliminate the *outage* instead.

Move the Google Health OAuth connection out of n8n and into this application, so that
reconnecting is a tap in the app's own settings page, staleness is visible on the
dashboard, and the first `invalid_grant` raises an alert.

### Why not keep n8n

n8n's `googleOAuth2Api` credential is genuinely good and was a reasonable original
choice. It stopped paying rent for three reasons:

- Its Reconnect button lives in n8n, behind a separate login. That is acceptable for a
  yearly reconnect and unacceptable for a weekly one.
- It cannot tell this application that the credential is dead. The staleness banner and
  alerting have to be built here **regardless of which option is chosen** — so keeping
  n8n does not avoid the work that matters, it only adds a hop in front of it.
- The validation rules in `n8n/health-hub-workflow.json` (`operations`, `combinations`,
  `datePattern`, rollUp timezone requirement) are duplicated verbatim in
  `lib/jobs/google-health-gateway.js`. Two copies in two languages, hand-synchronised,
  with tests on neither side of the boundary. Adding SpO2 would mean writing the same
  rules a third and fourth time.

n8n remains in service for other workflows and for outbound alert delivery — the thing
it is actually good at. Only the health sync path leaves.

### Credential storage

Tokens go in a dedicated `connector_credentials` table, **not** Better Auth's `account`
table. Rationale:

- `account` is owned by Better Auth and describes *login identities*. This is a service
  connection to a third-party API on behalf of the owner; conflating them invites
  Better Auth's own account-linking logic to act on rows it did not create.
- Single-flight refresh requires `SELECT ... FOR UPDATE` on a row this application
  fully controls.

Refresh and access tokens are encrypted at rest with a versioned AES-256-GCM keyring,
reusing the established `JOURNAL_ENCRYPTION_KEYS` pattern under a new
`CONNECTOR_ENCRYPTION_KEYS` variable and a distinct AAD label.

### Concurrency hazard

`sync-service.runOnce()` polls chunks on a 1s timer. When the access token expires,
several chunks can attempt a refresh simultaneously. Concurrent refreshes race on
Google's token rotation and consume the 50-tokens-per-client-user limit.

Refresh must be **single-flight**: one in-flight refresh per credential, others wait on
its result, serialised by a row lock so the guarantee survives process restarts.

This is the highest-risk element of the work and is implemented and tested first.

## Requirements

### R1 — Owned OAuth connection

- The app performs the authorization-code flow against Google directly, with
  `access_type=offline` and `prompt=consent` so a refresh token is always issued.
- CSRF protection via an HMAC-signed, time-limited `state` parameter derived from
  `DASHBOARD_SESSION_SECRET`. No server-side state storage.
- Requested scopes are exactly the four in use — `sleep.readonly`,
  `health_metrics_and_measurements.readonly`, `activity_and_fitness.readonly`,
  `profile.readonly`. The unused `location`, `nutrition`, `ecg` and `irn` restricted
  scopes are deliberately dropped to reduce blast radius on a health dataset.

### R2 — Single-flight refresh

- At most one refresh request per credential is in flight at any time.
- Concurrent callers await the same result rather than issuing their own request.
- A refresh returning `invalid_grant` marks the credential disconnected and does not
  retry; every other failure is retryable.

### R3 — Direct Google Health client

- `lib/jobs/google-health-client.js` preserves the existing gateway contract exactly:
  `request({ operation, metric, startDate, endDateExclusive, pageToken, timezone })`
  resolving to `{ ok, metric, status, data, nextPageToken, message }`.
- Because the contract is preserved, `sync-service.js`, `planner.js`, every normalizer
  and `metric-writer.js` are unchanged by this work.
- Selection between the n8n gateway and the direct client is controlled by
  `GOOGLE_CONNECTOR_MODE` (`n8n` | `direct`, default `n8n`) so cutover and rollback are
  configuration, not code.

### R4 — Visible connection health

- A settings view shows connection state, granted scopes, token expiry, last successful
  sync, and Connect / Reconnect / Disconnect actions.
- The dashboard shows a persistent banner whenever the connector is disconnected or the
  newest stored measurement is more than 36 hours old.
- `GET /api/connectors/google` returns this state as JSON.

### R5 — Alerting

- The first transition from connected to disconnected posts a message to an outbound
  webhook (`CONNECTOR_ALERT_WEBHOOK_URL`), delivered by n8n to Telegram.
- The message contains a direct link to the reconnect endpoint.
- Alerts are edge-triggered, not repeated per failed chunk.

### R6 — Backfill

- An operator script enqueues a bounded backfill for the 2026-07-25 → present gap.
- Raw metrics remain clamped to the existing 90-day retention window by
  `sync-service.enqueue`; no change to that behavior.

### R7 — SpO2

- Add `oxygen-saturation` (intraday samples) and `daily-oxygen-saturation` (daily
  summary) as first-class metrics.
- Both use operation `list`; filter fields are
  `oxygen_saturation.sample_time.civil_time` and `daily_oxygen_saturation.date`.
- Percentage values are 0–100. Fitbit Air is a supported source device.
- No Google Cloud console work is required: the necessary scope is already granted.

## Non-goals

- Publishing the OAuth app, verification, or CASA.
- Any iOS or Android companion application.
- Removing n8n as a service. Only the health sync path leaves; alert delivery stays.
- Changing the sync planner, normalizers, writer, archive, or export subsystems beyond
  the additive SpO2 work.
- Automating the weekly reconnect. It is a human consent action by design.

## Risks

| Risk | Mitigation |
|---|---|
| Concurrent refresh races / token limit exhaustion | Single-flight refresh under row lock, implemented and tested first |
| Cutover breaks sync entirely | `GOOGLE_CONNECTOR_MODE` defaults to `n8n`; the workflow stays deployed until direct mode is proven |
| Token compromise | AES-256-GCM at rest with versioned keyring; tokens never logged, never returned by any API |
| `prompt=consent` omitted, no refresh token issued | Explicitly asserted in the OAuth client tests |
| SpO2 response shape differs from assumption | Normalizer tolerates the same field aliases as the heart-rate normalizer; a live response is captured as a fixture before the writer is built |

## Open item requiring the owner

The redirect URI must be registered on the Google Cloud **Clients** page before the
flow can complete:

- `https://fitbit.philippeho.dev/api/connectors/google/callback`
- `http://localhost:3000/api/connectors/google/callback` (local development)

`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are the existing values from
the same OAuth client n8n uses; they are copied into Coolify, never into Git.
