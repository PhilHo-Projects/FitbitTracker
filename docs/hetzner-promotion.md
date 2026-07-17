# Hetzner Health Hub Promotion

## Current boundary

As verified on 2026-07-17, `fitbit.philippeho.dev` runs the legacy sleep dashboard from `main` at commit `ec2be2f`. Its Coolify image has no health-hub migration files, no `DATABASE_URL`, and no persistent application mount. It reads recent sleep directly through the legacy `fitness-sync` n8n workflow and does not own a PostgreSQL health archive.

The `codex/personal-health-data-hub` branch is therefore a product upgrade, not a byte-for-byte copy of the current production container. Its Docker image requires PostgreSQL during startup and applies `db/migrations/001_initial.sql` before serving traffic.

Local development uses the same application schema against the laptop-only `health-hub-postgres-live` Docker volume. Production must use a separate persistent PostgreSQL database on Hetzner; no production database dump is copied between the two environments.

## One-time Coolify setup

Do not replace the working legacy container until the health hub has passed its checks on a temporary Coolify hostname.

1. Create a managed PostgreSQL 16 resource in the existing Coolify production environment with persistent storage and backups.
2. Create a temporary Git-backed application from the same repository and Dockerfile, initially targeting the health-hub branch.
3. Attach the application to the PostgreSQL resource and configure:
   - `DATABASE_URL` using the Coolify internal PostgreSQL hostname.
   - `DATABASE_SSL=false` for the internal Docker network.
   - `DATABASE_POOL_SIZE=10`.
   - `JOURNAL_ENCRYPTION_KEYS` with a new versioned 32-byte AES key.
   - The existing production `DASHBOARD_PASSWORD` and `DASHBOARD_SESSION_SECRET`.
   - `N8N_WEBHOOK_URL=https://n8n.philippeho.dev/webhook/health-hub-sync`.
   - The matching health-hub header-auth token in `N8N_WEBHOOK_TOKEN`.
   - `SYNC_SCHEDULE_ENABLED=false` until the first bounded sync succeeds.
4. Deploy to the temporary hostname. Startup must apply migrations and `GET /readyz` must return HTTP 200.
5. Verify login, a one-day sleep-only sync, the Today dashboard, the Sleep workspace, journal encryption, and export creation.
6. Enable scheduled sync only after the bounded checks pass.
7. Point `fitbit.philippeho.dev` at the verified health-hub application. Keep the legacy application available for rollback until the new route is confirmed.

The AWS legacy server, the legacy `fitness-sync` workflow, and the current production application remain intact throughout this promotion.

## Normal update loop after promotion

After the one-time PostgreSQL setup and cutover, ordinary changes use one path:

1. Create a short feature branch from updated `main`.
2. Run and test it with `npm run dev` against the laptop PostgreSQL volume.
3. Push the branch and merge it to `main` after review.
4. Let Coolify rebuild the Git-backed application from `main`.
5. Verify `/readyz` and the changed UI or API behavior.

Application code and schema migrations then move through Git. Development and production databases remain separate persistent data stores, as they should.
