# FitbitTracker

A deliberately-basic dashboard that pulls **Google Fit** data through an **n8n** webhook and
renders it. First-pass plumbing test: confirm OAuth (handled in n8n) + the webhook leg work
end to end. Built with Node + Express + Tailwind, deployed to Hetzner/Coolify.

> **Heads up:** Google's Fit REST API is on a deprecation path, so the `fitness/*` calls may
> return errors or empty data. The `userinfo` call proves the OAuth connection works regardless —
> that's the real point of this test. See `docs/superpowers/specs/` for the full design.

## Architecture

```
Browser → Node /api/fitness → n8n webhook → Google Fit API → back → Browser
```

- **n8n** (`https://n8n.philippeho.dev`) holds the Google OAuth2 credential and does the API calls.
- **Node app** (`https://fitbit.philippeho.dev`) is a thin UI that proxies to the n8n webhook.

## Local development

```bash
npm install
cp .env.example .env      # optional; defaults point at the live n8n
npm run dev               # builds Tailwind (predev) then starts on http://localhost:3000
```

Open http://localhost:3000 and click **Sync from Google Fit**.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `N8N_WEBHOOK_URL` | `https://n8n.philippeho.dev/webhook/fitness-sync` | Webhook the dashboard calls |
| `N8N_WEBHOOK_TOKEN` | _(empty)_ | Shared `x-fitness-token` header; unused in pass 1 |

## One-time setup you need to do (only you can)

1. **Add the client secret.** Put it in `secrets/google-oauth.md` (gitignored) — the client ID
   alone can't complete OAuth.
2. **Add the redirect URI** to the Google OAuth client (Google Cloud Console → Credentials):
   ```
   https://n8n.philippeho.dev/rest/oauth2-credential/callback
   ```
3. **Import the workflow.** In n8n → Import from File → `n8n/fitness-workflow.json`.
4. **Create the Google OAuth2 credential** in n8n (client ID + secret + the scopes listed in
   `secrets/google-oauth.md`), connect your Google account, then select it on the 3 HTTP nodes.
5. **Activate** the workflow (toggle Active), then click Sync on the dashboard.

## Deploy (Hetzner / Coolify)

Built as a Coolify Dockerfile app under the **PhilHo-Projects** GitHub org, domain
`fitbit.philippeho.dev`. The multi-stage `Dockerfile` builds Tailwind then runs `node server.js`
on port 3000. Env vars are set in Coolify.

## Project layout

```
server.js                  Express server + /api/fitness proxy
public/                    index.html, app.js, built styles.css (gitignored)
src/input.css              Tailwind entry
n8n/fitness-workflow.json  Importable n8n workflow
secrets/google-oauth.md    Client ID/secret + scopes (gitignored)
docs/superpowers/specs/    Design doc
Dockerfile                 Multi-stage build for Coolify
```
