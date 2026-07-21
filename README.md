# Personal Health Data Hub

A private, single-user health archive for sleep, heart rate, calories, and dated journal context.
The app stores exact source records in PostgreSQL, presents a phone-friendly daily view, and
produces structured exports for later analysis by ChatGPT, NVIDIA, OpenAI, or another provider.

Production URL: `https://fitbit.philippeho.dev`

## Architecture

```text
Browser
  → password-backed Express session
  → PostgreSQL health archive
  → resumable sync worker
  → Header-Auth n8n gateway
  → Google Health API

PostgreSQL
  → shared analysis dataset service
  → AI-analysis ZIP / full archive ZIP / PNG summary
  → future provider-neutral AI adapter
```

- PostgreSQL is the source of truth.
- Express owns authentication, APIs, synchronization, journaling, summaries, and exports.
- n8n stores Google OAuth and acts only as an allow-listed Google Health gateway.
- Journal bodies and revisions use versioned AES-256-GCM encryption.
- Health records and normalized summaries are retained indefinitely.
- Completed export files remain private and expire after 24 hours.
- Built-in AI calls are intentionally deferred; exports and future adapters share the same
  normalized dataset contract.

## Local development

Requirements: Node.js 20+ and Docker Desktop.

```bash
npm install
# Create .env.local from .env.local.example and fill its n8n token.
npm run dev
```

`npm run dev` is the real-data, manual-sync mode. It reads `.env.local`, requires the authenticated
n8n gateway at `https://n8n.philippeho.dev/webhook/health-hub-sync`, and:

1. Starts PostgreSQL 16 on `127.0.0.1:54329`.
2. Applies SQL migrations.
3. Does not seed fixtures.
4. Builds Tailwind.
5. Starts the application at `http://localhost:3000`.

Local password: `0000`

Local development uses the existing remote n8n gateway; it does not install or run n8n locally.
Automatic sync scheduling is disabled locally, so all syncs are started manually through the app.
The first real-data sync can take several minutes when Google returns dense heart-rate history;
progress is checkpointed page by page and remains visible in the app.

For deterministic offline fixtures with no n8n dependency:

```bash
npm run dev:fixtures
```

Both local modes use password `0000` and separate PostgreSQL volumes:
`health-hub-postgres-live` for `npm run dev`, and `health-hub-postgres-fixtures` for
`npm run dev:fixtures`. `npm run dev:live` remains an alias for `npm run dev`.
Set `SKIP_LOCAL_DATABASE=true` only when `DATABASE_URL` points to a database managed separately.

Local and production use the same schema but separate persistent PostgreSQL data stores. Before the
first health-hub deployment, follow the [Hetzner promotion guide](docs/hetzner-promotion.md) for the
one-time Coolify PostgreSQL setup and safe cutover from the legacy dashboard.

For a lightweight UI preview backed by in-memory deterministic fixtures:

```bash
npm run preview
```

This starts `http://127.0.0.1:4173` with the same local password.

## Product workspaces

- **Today:** date browsing, one proportional sleep-stage bar, a four-column duration/percentage
  row, resting/range/average heart values without a dashboard chart, calories burned, and latest
  journal context.
- **Sleep:** selected-day metrics and a chronological four-lane Awake/REM/Light/Deep timeline,
  plus day/week/month/year trends and classic-sleep fallback.
- **Heart:** resting, average, minimum, maximum, sample count, coverage, five-minute min/max
  envelopes, and longer-range daily bands.
- **Calories:** total expenditure, active and basal energy kept separate, hourly day detail, and
  longer-range daily stacks.
- **Journal:** multiple timestamped entries per day, reusable tags, encrypted revisions, edit, and
  delete.
- **Export:** AI-analysis ZIP, full raw-data ZIP, and purpose-built PNG summaries.

## Data and synchronization

The initial schema is in `db/migrations/001_initial.sql`. It stores:

- Source accounts, timezone, profile, and Google Health membership start date.
- Sleep sessions and chronological stages.
- Raw heart-rate samples and daily summaries.
- Total, active, and basal calorie intervals and daily summaries.
- Joined daily health summaries with coverage and derivation flags.
- Persistent sync jobs/chunks, retries, pagination, and restart recovery.
- Encrypted journal entries, revisions, and searchable tags.
- Background export jobs and expiry metadata.

The worker synchronizes every three hours and supports manual recent, custom, and all-history jobs.
Windows are newest-first and remain within Google Health limits:

- 14 days: heart rate.
- 1 day: total calories when explicitly requested.
- 90 days: sleep, daily resting heart rate, active energy, and basal energy.

Google Health currently rejects documented `total-calories` rollup ranges with `400 Invalid time
range`. The gateway keeps the allow-listed operation available, but default syncs omit it so sleep,
heart rate, daily resting heart rate, active energy, and basal energy can finish successfully.

Every metric/window/page is checkpointed. Transient 429/5xx responses use bounded exponential
backoff, stale claims are recovered after restart, and metrics can complete independently.

The generated Personal Health Data Hub gateway uses:

- Artifact: `n8n/health-hub-workflow.json`
- Workflow ID: `healthHubGateway001`
- Webhook path: `health-hub-sync`
- Header Auth credential: `FitbitTracker Webhook Auth`
- Google credential ID/name: `zTvzoPpvTXOvI3rA` / `Google account`

The legacy sleep workflow remains preserved at `n8n/fitness-workflow.json` with workflow ID
`fitbitTracker001` and webhook path `fitness-sync`.

Build it with:

```bash
npm run build:workflow
```

Required Google OAuth scopes:

```text
https://www.googleapis.com/auth/googlehealth.sleep.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
```

After changing scopes, reconnect the n8n Google OAuth credential so its refresh token receives the
new permissions.

## API

All product APIs require the signed dashboard session.

```text
GET  /api/dashboard?date=YYYY-MM-DD
GET  /api/metrics/sleep?start=&end=
GET  /api/metrics/heart?start=&end=&resolution=day|five-minute
GET  /api/metrics/calories?start=&end=&resolution=day|hour

GET  /api/journal?start=&end=
POST /api/journal
PUT  /api/journal/:id
DELETE /api/journal/:id

POST /api/sync
GET  /api/sync/status

POST /api/exports
GET  /api/exports
GET  /api/exports/:id
GET  /api/exports/:id/download
```

Ranges are closed-open: `startDate` is inclusive and `endDateExclusive` is exclusive.

Compatibility wrappers remain available during rollout:

```text
POST /api/sleep
POST /api/fitness
```

Health endpoints:

```text
GET /healthz
GET /readyz
```

## Exports

AI-analysis ZIP contents:

```text
manifest.json
daily-summary.csv
sleep-sessions.csv
sleep-stages.csv
journal.md          # only when explicitly selected
summary.png         # optional
```

Full archives additionally stream:

```text
heart-rate-samples.csv
calorie-intervals.csv
```

The manifest records schema version, timezone, units, sources, range, column definitions,
derivation flags, coverage warnings, and file inventory. Structured values remain primary; PNGs
are fixed-layout companions generated from SVG, not screenshots of the browser viewport.

## Runtime configuration

See `.env.example`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL archive connection |
| `DATABASE_POOL_SIZE` | No | Pool size; defaults to 10 |
| `DATABASE_SSL` | No | Set `true` when the database requires TLS |
| `DASHBOARD_PASSWORD` | Yes | Private dashboard password |
| `DASHBOARD_SESSION_SECRET` | Yes | HMAC key for 12-hour sessions |
| `JOURNAL_ENCRYPTION_KEYS` | Yes | Versioned AES-256-GCM keyring |
| `N8N_WEBHOOK_URL` | For live sync | Secured `health-hub-sync` gateway |
| `N8N_WEBHOOK_TOKEN` | For live sync | Header Auth token shared with n8n |
| `SYNC_SCHEDULE_ENABLED` | No | Set `false` for manual-only sync; defaults to enabled |
| `SYNC_INTERVAL_HOURS` | No | Scheduled sync interval; defaults to 3 hours |
| `SYNC_SCHEDULE_LOOKBACK_DAYS` | No | Scheduled overlap window; defaults to 7 days |
| `RAW_RETENTION_DAYS` | No | Define the raw-retention cutoff only; does not authorize deletion |
| `HEALTH_COMPACT_WRITES_ENABLED` | No | Dual-write compact normalized rows; defaults to `false` |
| `HEALTH_RAW_PRUNING_ENABLED` | No | Allow verified-archive-only raw pruning; defaults to `false` |
| `HEALTH_COMPACT_BACKFILL_BATCH_SIZE` | No | Maximum legacy rows per compact operator batch; defaults to 1000 |
| `HEALTH_ARCHIVE_ENABLED` | No | Independently enable the monthly R2 archive worker; defaults to `false` |
| `HEALTH_ARCHIVE_S3_ENDPOINT` | When archive runs | S3-compatible R2 endpoint: `https://<account>.r2.cloudflarestorage.com` |
| `HEALTH_ARCHIVE_S3_REGION` | No | S3-compatible region; defaults to `auto` |
| `HEALTH_ARCHIVE_S3_BUCKET` | When archive runs | Private raw-archive bucket |
| `HEALTH_ARCHIVE_S3_ACCESS_KEY_ID` | When archive runs | Bucket-scoped Object Read/Write access key ID |
| `HEALTH_ARCHIVE_S3_SECRET_ACCESS_KEY` | When archive runs | Bucket-scoped Object Read/Write secret |
| `HEALTH_ARCHIVE_ENCRYPTION_KEYS` | When archive runs | Versioned AES-256 archive keys, using the journal keyring convention |
| `HEALTH_ARCHIVE_INTERVAL_HOURS` | No | Independent archive-worker interval; defaults to 24 hours |
| `HEALTH_ARCHIVE_BATCH_SIZE` | No | Maximum export/import/prune rows per batch; defaults to 1000 |
| `HEALTH_ARCHIVE_TEMP_DIR` | No | Controlled temporary disk directory removed after each operation |
| `EXPORT_STORAGE_DIR` | No | Private temporary export directory |
| `PORT` | No | Express port; defaults to 3000 |

Use unrelated secrets. In production, cookies are `HttpOnly`, `SameSite=Strict`, and `Secure`.
Mutations validate browser origin, login attempts are throttled, health responses use
`Cache-Control: no-store`, logs omit payloads/secrets, and restrictive CSP/permission headers are
enabled.

`RAW_RETENTION_DAYS` only limits high-volume raw metric ranges requested by backfill/custom sync;
sync completion never deletes rows. The only raw deletion path is the explicit archive operator
command below. It requires both archive/pruning gates, freshly downloads and fully verifies the
stored object, stages the authenticated CSV values, and deletes only exact matching compact rows
in bounded batches. Legacy raw tables, sleep, journals, and daily summaries remain permanent.

### Compact health operator

The compact operator is read-only by default. It never deletes legacy source rows and scans
backfills in bounded keyset batches.

```bash
# Compare legacy, compact, and finalized heart summaries. This is the default operation.
npm run health:compact -- --validate

# Preflight all source rows and duplicate semantic identities without writing.
npm run health:compact -- --backfill --batch-size 1000

# Explicitly migrate source streams and compact rows, refresh affected daily summaries once,
# then run validation.
npm run health:compact -- --backfill --execute --batch-size 1000
```

Validation reports account/date differences in counts, timestamp bounds, sums, minima, maxima,
coverage, and heart p05/median/p95. A duplicate legacy semantic identity aborts preflight before
the first compact write. Configure the default bound with `HEALTH_COMPACT_BACKFILL_BATCH_SIZE`.

### Encrypted monthly health archive

The archive worker is independently disabled by default and is never part of `/readyz` or normal
synchronization. A calendar month becomes eligible only after its final civil date is at least 90
days old. Creation exports only normalized compact measurements and their referenced canonical
source streams in bounded keyset pages.

Each archive contains exactly these deterministic files, in this order:

```text
manifest.json
source-streams.json
heart-rate-samples.csv
calorie-intervals.csv
```

The files are placed in the version-1 length-prefixed bundle, deterministically gzip-compressed,
and then encrypted with a fresh AES-256-GCM nonce. The `HHARCHV1` envelope is:

```text
8-byte magic
4-byte big-endian authenticated-header length
authenticated UTF-8 JSON header
AES-256-GCM ciphertext of the complete gzip bundle
16-byte authentication tag
```

The catalog plaintext SHA-256 covers the complete compressed bundle. The ciphertext SHA-256
covers every stored envelope byte and forms the immutable object name:
`health-hub/raw/v1/YYYY/MM/health-raw-YYYY-MM-<full-lowercase-sha256>.hharchive`. Upload uses
`If-None-Match: *`; a pre-existing object is accepted only after complete readback matches both its
full hash and byte count. Verification then authenticates/decrypts the envelope and rechecks the
manifest schema, month, source account, row counts, and all content hashes.

The application does not create R2 buckets, object locks, or lifecycle policies. Keep the archive
bucket private and permanent, and provision those controls outside the application. No decrypted
health data is retained outside an explicit extraction directory; verification and import use
controlled temporary files that are removed on success or failure.

```bash
# Catalog only; no R2 configuration is needed. Results default to 50 and never exceed 100.
npm run health:archive -- list --limit 50

# Continue a catalog page with the opaque nextCursor returned by the previous command.
npm run health:archive -- list --limit 50 --cursor <nextCursor>

# Eligibility-only dry run; no network operation or catalog mutation.
npm run health:archive -- run --source-account <uuid> --month 2026-01-01

# Explicit create/upload/readback verification. This does not prune.
npm run health:archive -- run --source-account <uuid> --month 2026-01-01 --execute

# Reverify the complete immutable object named by a catalog entry.
npm run health:archive -- verify --id <catalog-uuid>

# Retain decrypted files only in this explicit operator directory.
npm run health:archive -- extract --id <catalog-uuid> --output ./restore/2026-01

# Restore into a separate disposable PostgreSQL database.
npm run health:archive -- import --id <catalog-uuid> \
  --target-database-url postgres://restore:password@127.0.0.1:5432/health_hub_restore_test

# Destructive compact-row pruning needs this explicit command plus both
# HEALTH_ARCHIVE_ENABLED=true and HEALTH_RAW_PRUNING_ENABLED=true.
npm run health:archive -- run --source-account <uuid> --month 2026-01-01 --execute --prune
```

Import always requires an explicit target URL. It refuses the current `DATABASE_URL`, remote
hosts, and targets without a disposable-looking database name unless
`--allow-production-target` is deliberately supplied. The target must already have migrations and
the archived source-account row. Imports are bounded and idempotent on compact semantic keys.

## Verification

```bash
npm test
npm run build
npm run build:workflow
docker build -t personal-health-data-hub .
```

The suite covers migrations, fixture replay, idempotent corrections, DST/civil dates,
missing-versus-zero values, sparse coverage, job pagination/restart recovery, journal encryption
and revisions, exports, API authorization, workflow structure, responsive layout regressions, and
PNG layout.

Browser QA uses the Playwright CLI against `npm run preview` at phone and desktop widths.

## Deployment

The production Docker image:

1. Installs deterministic dependencies with `npm ci`.
2. Builds Tailwind.
3. Applies pending migrations before server startup.
4. Exposes port 3000.
5. Uses `/healthz` for the Docker health check and `/readyz` for migration/database readiness.

For Coolify:

- Create a private PostgreSQL 16 resource.
- Set the runtime variables from `.env.example`.
- Keep the historical import disabled until a recent seven-day live sync is compared with Google
  Health.
- Configure private PostgreSQL backups to Cloudflare R2 with 30 daily and 12 monthly restore
  points, then perform an actual restore test.
- Keep the existing AWS deployment available until the new archive is verified.

## Project layout

```text
db/migrations/              PostgreSQL schema
lib/db/                     pools, migrations, fixtures, repositories, metric writer
lib/metrics/                Google Health normalizers
lib/jobs/                   gateway, planning, persistent sync worker
lib/journal/                encryption and repository
lib/exports/                dataset, CSV, ZIP, PNG, retention worker
lib/routes/                 composed authenticated Express routers
public/                     framework-free browser modules and HTML
src/input.css               responsive product styling
n8n/fitness-workflow.json   preserved legacy Google Health sleep workflow
n8n/health-hub-workflow.json generated Personal Health Data Hub OAuth/API gateway
scripts/                    dev, preview, migration, seed, workflow, production start
test/                       Node test suite
Dockerfile                  Coolify production image
```
