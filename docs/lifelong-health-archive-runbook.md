# Lifelong Health Archive Runbook

## Retention contract

- Sleep sessions, journal entries, daily health summaries, and enhanced daily heart statistics
  remain in PostgreSQL permanently.
- Exact normalized heart-rate and calorie measurements remain online for at least 90 days.
  Archival closes whole calendar months, so normal hot retention is approximately 90–121 days.
- Before any exact compact row is pruned, its immutable monthly R2 object is downloaded in full,
  hash-checked, authenticated/decrypted, schema-checked, and staged back into PostgreSQL. Deletion
  targets only exact full-value matches from that verified object.
- Weekly, monthly, yearly, and lifetime heart results derive from permanent daily counts, sums,
  sums of squares, minima, maxima, and coverage. Daily-distribution percentiles are labeled as
  such; daily standard deviations are never averaged.
- Original repetitive Google response pages are not retained. Exact normalized measurements and
  canonical source-stream metadata are the permanent raw record.

## Independent safety gates

All gates default to `false` and serve different purposes:

| Gate | Effect |
| --- | --- |
| `HEALTH_COMPACT_WRITES_ENABLED` | Dual-write new normalized rows to compact shadow tables |
| `HEALTH_ARCHIVE_ENABLED` | Permit the independent archive worker and operator to use R2 |
| `HEALTH_RAW_PRUNING_ENABLED` | Permit explicit verified-archive compact-row pruning |

`RAW_RETENTION_DAYS` defines eligibility; it never authorizes deletion. Normal synchronization
has no deletion path. Read cutover, legacy-table rename/drop, pruning, and WAL tuning are separate
operator decisions and are not represented by the three gates above.

## R2 layout and credential custody

Create two private buckets in the same Cloudflare account:

- `philippeho-health-hub-raw-archive`
- `philippeho-coolify-db-backups`

Create a separate bucket-scoped Object Read/Write token for each bucket. Do not reuse a general
Cloudflare API token. The raw-archive token belongs only in the Health Hub Coolify environment;
the backup token belongs only in Coolify S3 storage. Store both tokens and the archive encryption
keyring in the user's password manager. Never put their values in Git, tickets, logs, screenshots,
or chat.

Raw archive bucket controls:

- Public access disabled; no custom public domain.
- No lifecycle deletion rule.
- Indefinite bucket-lock rule for prefix `health-hub/raw/v1/`.
- Objects are content-addressed and created with `If-None-Match: *`; rebuilding a month creates a
  new object and catalog version instead of overwriting the prior object.

Backup bucket controls:

- Public access disabled; no custom public domain.
- Keep unique dump object names. Retention is controlled by the Coolify schedules below rather
  than S3 versioning.

## Health Hub R2 configuration

Set these only in Coolify after the raw bucket and token exist:

```text
HEALTH_ARCHIVE_ENABLED=false
HEALTH_RAW_PRUNING_ENABLED=false
HEALTH_ARCHIVE_S3_ENDPOINT=https://<cloudflare-account-id>.r2.cloudflarestorage.com
HEALTH_ARCHIVE_S3_REGION=auto
HEALTH_ARCHIVE_S3_BUCKET=philippeho-health-hub-raw-archive
HEALTH_ARCHIVE_S3_ACCESS_KEY_ID=<password-manager/Coolify only>
HEALTH_ARCHIVE_S3_SECRET_ACCESS_KEY=<password-manager/Coolify only>
HEALTH_ARCHIVE_ENCRYPTION_KEYS=1:<base64-encoded-random-32-byte-key>
```

Leave both gates false during initial credential setup. Enabling archive creation requires a
separate release decision; enabling pruning requires the later restore-tested approval gate.
Archive initialization failures disable only the archive worker and do not affect `/readyz` or
normal synchronization.

## Coolify database backup schedules

Register `philippeho-coolify-db-backups` as private S3-compatible storage with region `auto` and
the Cloudflare R2 endpoint. Use its dedicated bucket token and run Coolify's connection test.

Configure the Health Hub PostgreSQL resource as follows:

1. Existing daily schedule: `03:00`, retain 7 local copies, save to R2, retain 30 R2 copies.
2. Separate monthly schedule: `03:30` on day 1, R2 only, retain 12 R2 copies.

Do not delete or replace the working local schedule. First verify a new remote dump object, then
perform the disposable restore drill below.

## Release sequence

1. Deploy additive migrations and application code with every new gate false.
2. Enable compact dual writes only; run the bounded compact backfill and validation.
3. Run at least two scheduled overlap syncs. The second identical import must report unchanged
   compact rows and zero compact updates.
4. Configure R2 credentials while archive creation remains disabled.
5. Enable archive creation without pruning; build and verify one eligible month.
6. Complete both disposable restore drills and record the evidence.
7. Approve and enable the compact read/export cutover behind the release configuration. Keep
   legacy tables and dual writes available for rollback.
8. Observe multiple scheduled syncs.
9. First explicit approval: atomically rename compact tables into their final names while retaining
   legacy tables for the rollback window.
10. Second explicit approval: only after the rollback window and repeat restore evidence, drop
    legacy tables and enable explicit archive-driven pruning.
11. After at least one week of stable duplicate-write suppression, separately trial
    `max_wal_size=512MB`. Keep checkpoint timeout at five minutes and completion target at `0.9`;
    revert if requested checkpoints or write latency increase. Do not begin with 256 MB.

## Operator commands

```bash
# Compact validation only (default, read-only)
npm run health:compact -- --validate

# Compact dry-run/preflight
npm run health:compact -- --backfill --batch-size 1000

# Explicit compact backfill and validation
npm run health:compact -- --backfill --execute --batch-size 1000

# Bounded archive catalog listing
npm run health:archive -- list --limit 50

# Eligibility-only archive dry run
npm run health:archive -- run --source-account <uuid> --month YYYY-MM-01

# Explicit immutable archive creation and readback verification; no prune
npm run health:archive -- run --source-account <uuid> --month YYYY-MM-01 --execute

# Full stored-object verification
npm run health:archive -- verify --id <catalog-uuid>

# Explicit rebuild after a verified archive is made stale by corrected/late data
npm run health:archive -- run --source-account <uuid> --month YYYY-MM-01 --execute --rebuild

# Authenticated extraction to a new operator directory
npm run health:archive -- extract --id <catalog-uuid> --output ./restore/YYYY-MM

# Re-import into a migrated disposable database
npm run health:archive -- import --id <catalog-uuid> \
  --target-database-url postgres://restore:<password>@127.0.0.1:5432/health_hub_restore_test

# Protected destructive operation; requires both archive and pruning gates
npm run health:archive -- run --source-account <uuid> --month YYYY-MM-01 --execute --prune
```

## Quarterly restore drills

### Coolify database dump

1. Select one completed R2 dump and record its object name, size, and completion time.
2. Create a disposable PostgreSQL instance that cannot receive production traffic.
3. Restore the dump and run migrations only if the dump predates a current additive migration.
4. Verify table inventory, source-account count, daily-summary bounds, recent exact-row counts,
   journal decryptability, and application `/readyz` against the disposable target.
5. Remove the disposable database after recording results.

### Encrypted health archive

1. Select one `verified` (or previously verified `superseded`/`pruned`) catalog ID.
2. Run `verify`, then `extract` into a new controlled directory.
3. Create a migrated disposable database and seed only the matching source-account row.
4. Run `import` without `--allow-production-target`.
5. Compare manifest and restored heart/calorie counts, timestamp bounds, sums, minima/maxima, and
   at least one microsecond timestamp and nullable upstream ID edge.
6. Remove the extracted plaintext directory and disposable database.

### Restore-test record

```text
Date/time (UTC):
Operator:
Release/commit:
Database dump object (safe name only):
Archive catalog ID/month/version (no object URL or secrets):
Disposable target:
Database restore result and checks:
Archive verify/import result and checks:
Plaintext cleanup confirmed:
Disposable resources removed:
Follow-up actions:
```

### Restore-test history

```text
Date/time (UTC): 2026-07-22 01:01
Operator: Codex using Philippe's authorized Cloudflare/Coolify/Hetzner sessions
Release/commit: be1c0ef (implementation branch; not deployed)
Database dump object (safe name only): pg-dump-health_hub-1784682060.dmp (28,594,936 bytes)
Archive catalog ID/month/version (no object URL or secrets): Not yet eligible; archive drill pending
Disposable target: PostgreSQL 16 container fitbit-r2-restore-pg-20260721, no published port
Database restore result and checks: PASS; R2 download SHA-256 4a79d9dc77438fc8506dd6cab47cabcb88cea043398f6906e2e7d07700154ff1; pg_restore --exit-on-error; 344,453 heart samples, 8,572 calorie intervals, 28 heart daily summaries, 29 sleep sessions, 1 source account
Archive verify/import result and checks: Pending; raw bucket credential separately passed upload/readback/SHA-256/delete outside locked prefix
Plaintext cleanup confirmed: Yes; temporary downloaded dump removed
Disposable resources removed: Yes; PostgreSQL container and host temporary directory confirmed absent
Follow-up actions: Complete encrypted health archive verify/extract/import drill before archive or pruning approval
```

## Failure and rollback behavior

- R2/encryption/upload/readback/verification/catalog failure: record a safe catalog error and keep
  every PostgreSQL row. Application readiness and sync continue.
- Prune mismatch from late/corrected data: keep rows, explicitly rebuild a new immutable version,
  and retain the old object/version.
- Interrupted prune: rerun the explicit command. Missing already-pruned archived rows are allowed;
  extra or corrected current rows still abort.
- Before legacy removal: disable archive/pruning, disable compact reads, and switch reads back to
  legacy tables. Dual-written data remains available.
- After legacy removal: exact recovery requires a verified database backup or monthly R2 archive.
- Suspected encryption-key loss or object corruption: stop pruning immediately, preserve all hot
  rows and backups, and do not rotate/delete the affected key version until recovery is proven.

## Approval record

Record each gate independently with date, operator, commit/deployment, validation evidence, and
rollback target:

- Compact dual writes enabled
- Archive creation enabled
- Database restore drill passed
- Archive restore drill passed
- Compact read/export cutover approved
- Compact/final table rename approved
- Legacy table removal approved
- Archive-driven pruning approved
- WAL trial approved
