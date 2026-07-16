# FitbitTracker

A private, sleep-first dashboard for Fitbit and Pixel Watch data. The browser talks to a small
Express app, Express proxies an authenticated request to n8n, and n8n fetches the latest seven
local sleep dates from the Google Health API.

Production: `https://fitbit.philippeho.dev`

## Architecture

```text
Browser
  → password-backed Express session
  → POST /api/sleep
  → Header-Auth n8n webhook
  → Google Health identity + reconciled sleep endpoints
  → normalized latest night, stages, seven-night history, naps, and averages
```

- Google OAuth credentials remain in n8n.
- The n8n shared token remains in n8n and the Express runtime environment.
- The browser receives neither credential.
- The app stores no sleep data; each refresh fetches live data.

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

Set all four security/integration variables in `.env`, then open
`http://localhost:3000`. `npm run dev` rebuilds Tailwind before starting Express.

For a separate development n8n workflow, point `N8N_WEBHOOK_URL` at an n8n test webhook. The
application code is otherwise identical between environments.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | Express port; defaults to `3000` |
| `DASHBOARD_PASSWORD` | Yes | Password accepted by `/api/login` |
| `DASHBOARD_SESSION_SECRET` | Yes | HMAC key for 12-hour session cookies |
| `N8N_WEBHOOK_URL` | Yes | Production or test `fitness-sync` webhook URL |
| `N8N_WEBHOOK_TOKEN` | Yes | Value sent in the `x-fitness-token` header |

Use long, unrelated values for the dashboard password, session secret, and webhook token. The
session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` in production. Authenticated pages
and health-data responses send `Cache-Control: no-store`.

## Google Health and n8n setup

The workflow ID remains `fitbitTracker001` and the production webhook remains
`POST /webhook/fitness-sync`.

1. Enable the Google Health API (`health.googleapis.com`) in the Google Cloud project used by
   the n8n OAuth client.
2. Add this scope to the OAuth consent screen and the dedicated n8n Google OAuth credential:

   ```text
   openid email profile https://www.googleapis.com/auth/googlehealth.sleep.readonly
   ```

3. Ensure this redirect URI is allowed on the Google OAuth client:

   ```text
   https://n8n.philippeho.dev/rest/oauth2-credential/callback
   ```

4. Reconnect the n8n credential after changing its scope. The old refresh token cannot gain the
   new Google Health permission without a new browser consent.
5. Create an n8n Header Auth credential named `FitbitTracker Webhook Auth`:

   ```text
   Header: x-fitness-token
   Value:  same value as N8N_WEBHOOK_TOKEN
   ```

6. Build or import the workflow:

   ```bash
   npm run build:workflow
   ```

   Import `n8n/fitness-workflow.json`, assign both Google Health HTTP nodes to the dedicated
   `Google account` credential, then publish the workflow.

The `Prep` Code node calculates seven civil dates in `America/Toronto`. Change that zone in
`scripts/build-n8n-workflow.mjs` if the dashboard owner moves permanently.

## Google Health request

The workflow calls:

```text
GET https://health.googleapis.com/v4/users/me/identity
GET https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints:reconcile
```

The sleep request uses the `google-wearables` data-source family, a civil end-time range, and the
maximum supported page size for sleep sessions. Staged sleep, classic sleep, duplicate records,
naps, missing stages, and empty date ranges are normalized into one stable UI contract.

## Verification

```bash
npm test
npm run build
npm run build:workflow
docker build -t fitbit-tracker .
```

The tests cover session signing, protected routes, n8n proxy behavior, Google Health
normalization, UI calculations, workflow structure, expressions, and Code-node syntax.

## Deployment

The app is a Git-backed Coolify Dockerfile application under the `PhilHo-Projects` organization.
The multi-stage image compiles Tailwind, installs production dependencies, and runs
`node server.js` on port `3000`.

Required production runtime variables:

```text
DASHBOARD_PASSWORD
DASHBOARD_SESSION_SECRET
N8N_WEBHOOK_URL
N8N_WEBHOOK_TOKEN
```

After deployment, verify:

- `/healthz` returns HTTP 200.
- `/` redirects unauthenticated visitors to `/login`.
- A valid login sets the signed session cookie.
- `/api/sleep` rejects calls without a session.
- The dashboard renders a real seven-night Google Health response after OAuth consent.

## Project layout

```text
server.js                    Express app, sessions, protected proxy
lib/session.js               HMAC session tokens and cookie parsing
lib/sleep-normalizer.js      Tested Google Health normalization contract
public/                      Login and responsive sleep dashboard
src/input.css                Tailwind entry and product styling
n8n/fitness-workflow.json    Importable production workflow
scripts/build-n8n-workflow.mjs
                             Generates the workflow from the tested normalizer
test/                        Node test runner coverage
docs/superpowers/            Design and implementation plan
Dockerfile                   Coolify production image
```
