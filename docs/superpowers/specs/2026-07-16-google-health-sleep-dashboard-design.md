# Google Health Sleep Dashboard Design

## Goal

Turn the existing Google Fit connectivity prototype into a private, sleep-first dashboard that fetches the latest seven nights of Fitbit/Pixel Watch sleep data through n8n and Google Health API.

## Architecture

The browser talks only to the Express app. Express authenticates the user with a password-backed signed session cookie and proxies an authenticated request to the existing n8n webhook. n8n owns the Google OAuth credential, calls Google Health API, normalizes sleep sessions and stages, and returns a stable dashboard contract.

```text
Browser -> Express session auth -> POST /api/sleep
        -> n8n header-auth webhook
        -> Google Health identity + reconciled sleep endpoints
        -> normalized seven-night JSON
        -> dashboard
```

The existing workflow ID `fitbitTracker001` and production webhook path `fitness-sync` remain stable. Google Fit API nodes are replaced rather than kept as a parallel data source.

## Data and UI

- Fetch sleep records ending during the latest seven local calendar dates with Google Health scope `https://www.googleapis.com/auth/googlehealth.sleep.readonly`.
- Reconcile the `sleep` data type using the `google-wearables` data-source family.
- Normalize main sleep and naps separately. Each main sleep record includes start/end time, duration, asleep/awake minutes, calculated efficiency, stages, stage totals, and device/source metadata.
- Return latest-night metrics plus seven-night averages and per-night records. Missing, classic, and stage-based records remain valid responses rather than workflow failures.
- Present a restrained dark product dashboard with latest-night summary, stage timeline, seven-night duration chart, nightly history, sync/error states, and collapsible diagnostics.

## Security and Environments

- Require `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET`; issue an `HttpOnly`, `SameSite=Strict` signed cookie with `Secure` enabled in production.
- Protect the n8n webhook with its native Header Auth credential and keep the shared token only in n8n/Coolify secrets.
- Send `Cache-Control: no-store` on authenticated pages and health-data API responses.
- Use `N8N_WEBHOOK_URL` to select n8n test or production webhook URLs; no duplicated workflow is required for development.

## Error Handling

- Express converts n8n network and non-2xx failures into clean `502` responses without leaking secrets.
- n8n uses full HTTP responses with non-throwing API nodes and reports identity and sleep failures independently.
- OAuth scope/API configuration failures are visible in the dashboard with actionable diagnostics.
- Empty sleep results return HTTP 200 with an empty-state message.

## Acceptance Criteria

- An unauthenticated visitor cannot view the dashboard or call `/api/sleep`.
- A valid login can fetch and render real Google Health sleep data from the live n8n workflow.
- Stage-based sleep shows awake/light/deep/REM data; classic sleep and missing-stage nights degrade gracefully.
- Local tests cover session signing, protected routes, proxy behavior, sleep normalization, and UI helper calculations.
- The Docker image builds and the deployed `/healthz`, login flow, dashboard, and live sync all work on `fitbit.philippeho.dev`.

