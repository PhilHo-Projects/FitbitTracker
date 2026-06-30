# FitbitTracker — first-pass design (2026-06-29)

## Goal

Prove the end-to-end plumbing works: **Google auth (in n8n) → fitness data pulled by n8n →
exposed via webhook → rendered by a basic Node + Tailwind dashboard deployed to
Hetzner/Coolify.** Grab as much data as possible; surface errors per-section instead of
hiding them. This is a connectivity/auth test, not a polished product.

## Decisions (from brainstorming)

- **Data source:** Google Fit REST API (the user enabled read-only Google APIs and supplied a
  Google OAuth client ID). Not Fitbit's own Web API — that would need a separate Fitbit app.
- **Auth lives in n8n.** The user connects a Google OAuth2 credential inside n8n. The Node app
  does no OAuth; it talks to n8n over a webhook secured (optionally) by a shared header token.
- **Architecture:** Node pulls from n8n via webhook; n8n pulls from Google. (Node → n8n → Google.)
- **Run target:** Both the Node app and n8n run on Hetzner. n8n is already live at
  `https://n8n.philippeho.dev` (Coolify, n8nio/n8n:2.25.7). The dashboard deploys to
  `https://fitbit.philippeho.dev` via a Coolify Dockerfile app.

## Architecture

```
Browser ──click──▶ Node /api/fitness ──POST + x-fitness-token──▶ n8n webhook /webhook/fitness-sync
                                                                       │
                                  (Google OAuth2 credential, user-connected)
                                  ├─ GET  oauth2/v3/userinfo          (proves auth)
                                  ├─ GET  fitness/v1/.../dataSources  (what data exists)
                                  └─ POST fitness/v1/.../dataset:aggregate (7d steps/cals/distance/HR)
                                                                       │
                                  Code node merges + captures per-call errors → Respond to Webhook
                                                                       │
Browser ◀── rendered cards + status pills + raw JSON ◀── Node ◀───────┘
```

## Components

1. **`secrets/google-oauth.md`** (gitignored): client ID, placeholder for client secret, scopes,
   the n8n redirect URI, and the shared-token note.
2. **`n8n/fitness-workflow.json`**: importable workflow. Webhook → verify-token Code node
   (computes the 7-day window) → 3 HTTP Request nodes (Google OAuth2 cred, `onError: continue`)
   → merge Code node producing a friendly `{ auth, summary, sections }` shape → Respond to Webhook.
3. **Node + Express + Tailwind app**: `server.js` serves `public/` and proxies `/api/fitness` to
   the n8n webhook (token stays server-side, dodges CORS). One dashboard page with a Sync button,
   per-section status pills, metric cards, and a raw-JSON dump. Tailwind v3 via CLI build.
4. **Deploy**: Dockerfile (multi-stage: build Tailwind, run server). GitHub repo under
   **PhilHo-Projects**. Coolify app on `fitbit.philippeho.dev`, env vars set via the Coolify API.

## Response contract (n8n → Node → browser)

```json
{
  "ok": true,
  "generatedAt": "ISO",
  "auth":   { "ok": true, "user": { "email": "...", "name": "...", "picture": "..." } },
  "summary":{ "totalSteps": 0, "totalCalories": 0, "totalDistanceMeters": 0, "avgHeartRateBpm": null, "days": 7 },
  "sections": {
    "userinfo":    { "ok": true,  "status": 200, "data": { } },
    "dataSources": { "ok": false, "status": 403, "count": 0, "error": "..." },
    "aggregate":   { "ok": false, "status": 403, "error": "..." }
  }
}
```

The frontend reads these defensively (optional chaining) and always shows the raw JSON, so an
unexpected shape degrades gracefully rather than crashing.

## Error handling

Each Google call uses n8n `onError: continueRegularOutput`; the merge node records
`{ ok, status, error }` per section. A dead/disabled Fitness API still returns HTTP 200 from the
webhook with `userinfo.ok: true` proving auth and `aggregate.ok: false` explaining the failure.

## Known risks

- **Google Fit REST API deprecation** — `fitness/*` may 403/empty. `userinfo` still proves auth.
  If Fit is unusable, pivot to Fitbit's own Web API (separate app) in a later pass.
- **Shared token** is not enforced in pass 1 (empty = disabled). Documented hardening step.

## Out of scope (this pass)

Persistence/DB, scheduled background pulls, historical charts, multi-user, polished UI.
