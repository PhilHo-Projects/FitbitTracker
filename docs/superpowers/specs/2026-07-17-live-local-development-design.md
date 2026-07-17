# Live Local Development Design

## Goal

Make `npm run dev` start the newer Personal Health Data Hub locally with password `0000`, a
local PostgreSQL archive, and live synchronization through the existing authenticated n8n
gateway on Hetzner. Running n8n on the laptop is explicitly out of scope.

## Current Regression

The Personal Health Data Hub pass changed `npm run dev` into an offline fixture mode and placed
the authenticated n8n setup behind `npm run dev:live` plus `.env.live`. The local application is
healthy, but the default command seeds deterministic records and never configures the live sync
worker. This makes the UI look disconnected when the expected behavior is to test against real
Google Health data.

## Chosen Behavior

`npm run dev` is the primary live-development command. It must:

1. Load a gitignored `.env.local` file.
2. Start the local PostgreSQL 16 service through Docker Desktop.
3. Use a dedicated persistent live-development PostgreSQL volume.
4. Apply all database migrations without seeding fixture records.
5. Build Tailwind and start the Express application on `http://localhost:3000`.
6. Accept the local dashboard password `0000`.
7. Start the sync worker with the Hetzner n8n URL and Header Auth token from `.env.local`.

The existing Hetzner n8n instance remains the only n8n runtime. It continues to own Google OAuth
and the allow-listed Google Health gateway. The browser never receives the n8n token.

## Development Modes

### Live development

Command: `npm run dev`

- Loads `.env.local` explicitly with `dotenv`.
- Requires `N8N_WEBHOOK_URL` and `N8N_WEBHOOK_TOKEN`.
- Uses local password `0000` regardless of production credentials.
- Uses the live-development PostgreSQL volume.
- Does not seed fixtures.
- Persists synchronized health data across restarts.

The initial local `.env.local` will be populated from the existing Hetzner/Coolify integration
configuration without printing or committing secret values.

### Fixture development

Command: `npm run dev:fixtures`

- Requires no Google, n8n, or production credentials.
- Uses the separate fixture PostgreSQL volume.
- Applies migrations and seeds deterministic fixtures idempotently.
- Uses password `0000`.

`npm run dev:live` remains as a backwards-compatible alias for `npm run dev` during the
transition, while `.env.live` is retired in favor of the conventional `.env.local` name.

## Data Isolation

Live and fixture modes must never share a PostgreSQL volume. The Docker Compose configuration
will select the appropriate named volume from an environment value supplied by the development
launcher. Switching modes may recreate the local PostgreSQL container, but it must preserve both
named volumes and their contents.

No production database is used locally. Only the n8n gateway is remote; all synchronized records,
journal entries, sync jobs, and exports stay in the laptop's live-development PostgreSQL volume.

## Configuration and Security

`.env.local` is gitignored and contains only local runtime configuration. It includes:

- local PostgreSQL connection details;
- `DASHBOARD_PASSWORD=0000`;
- a local-only session secret and journal encryption key;
- the production n8n webhook URL and matching Header Auth token;
- the live-development volume selection.

Coolify and production environment variables are unchanged. Secret values must not appear in
commits, logs, test snapshots, or documentation.

## Startup and Error Handling

The development launcher must fail before starting Express when:

- `.env.local` is missing;
- either n8n variable is empty or still contains a placeholder;
- Docker Desktop cannot start the PostgreSQL service;
- PostgreSQL does not become ready within the bounded wait period;
- migrations or the Tailwind build fail.

Each failure message must state the corrective action. The launcher must forward `SIGINT` and
`SIGTERM` to Express while leaving PostgreSQL data persisted in Docker.

## Testing

Automated tests will prove that:

- `npm run dev` selects live mode, loads `.env.local`, requires n8n credentials, uses password
  `0000`, selects the live database volume, and skips fixture seeding;
- `npm run dev:fixtures` selects the fixture volume and seeds deterministic data;
- the two modes cannot resolve to the same volume;
- secret values are absent from tracked examples and generated output;
- existing session, API, sync, database, workflow, layout, and export tests still pass.

An end-to-end local smoke test will then run `npm run dev`, log in with `0000`, enqueue a recent
sync, confirm the worker reaches the Hetzner n8n gateway, and verify that synchronized data can be
read from the local dashboard API. The smoke-test report will expose statuses and counts only, not
private health records or credentials.

## Non-Goals

- Installing or maintaining n8n on the laptop.
- Connecting local development to the production PostgreSQL database.
- Changing Google OAuth, the n8n workflow, Coolify, or production deployment behavior.
- Committing `.env.local` or any credential.

## Success Criteria

From the newer `personal-health-data-hub` checkout, a developer with Node.js and Docker Desktop
can run `npm run dev`, open `http://localhost:3000`, log in with `0000`, trigger synchronization
through Hetzner n8n, and inspect the resulting real health data stored only in the local PostgreSQL
volume. Fixture testing remains available through `npm run dev:fixtures`.
