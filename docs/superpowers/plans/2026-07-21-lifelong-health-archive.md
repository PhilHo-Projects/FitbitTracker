# Lifelong Health Archive Implementation Plan

## Global constraints

- Preserve the dirty primary checkout and build only on `codex/fitbit-lifelong-storage`.
- Keep AWS legacy services untouched.
- PostgreSQL keeps exact heart-rate and calorie measurements for at least 90 days; archive eligibility is month-based, so effective hot retention is approximately 90-121 days.
- Permanent online reporting resolution is enhanced daily summaries. Weekly, monthly, yearly, and lifetime results derive from daily rows; do not add duplicate period summary tables.
- Archive exact normalized measurements plus canonical source metadata, not repetitive original Google response pages.
- R2 archives are compressed, AES-256-GCM encrypted, immutable, content addressed, private, and permanent.
- R2 or archive failures must never affect application readiness or synchronization and must never permit raw-row deletion.
- No raw pruning, legacy-table removal, read cutover, or WAL tuning is enabled without the separate approvals required by the rollout plan.
- Credentials remain outside Git and must never be logged or exposed through APIs.
- Use test-driven development. PostgreSQL-specific behavior must have real PostgreSQL 16 integration coverage in addition to the existing fast suite.

## Task 1: PostgreSQL 16 test harness and compact shadow schema

Create the first safe release foundation.

- Add an opt-in real PostgreSQL 16 integration-test harness driven by `PG_INTEGRATION_URL`, plus a GitHub Actions service using PostgreSQL 16. The normal local suite may skip integration tests when the URL is absent, but CI must run them.
- Add an additive migration only. Do not rename or drop any current table or index.
- Create `source_streams` with canonical source/device metadata stored once and uniqueness on `(source_account_id, metadata_hash)`.
- Create compact shadow heart and calorie tables. Each row retains the source account, source stream, civil date, timestamp or interval, UTC offset, measurement, optional upstream sample ID, and audit timestamps. Do not store repeated source JSON, empty device JSON, textual derived provider keys, or a redundant UUID primary key.
- Heart semantic identity is `(source_stream_id, sampled_at)`. Calorie semantic identity is `(source_stream_id, interval_type, start_at)` and the end timestamp remains a value that a correction may update.
- Add a covering heart access index on `(source_account_id, civil_date, sampled_at)` with the remaining detail-query columns included where useful. Do not recreate the old UUID or 64-character provider-key indexes.
- Add new enhanced daily-heart columns: BPM sum, BPM sum of squares, population standard deviation, p05, median, p95, aggregation version, and finalized timestamp while retaining resting/minimum/mean/maximum, sample count, and existing coverage semantics.
- Add an archive catalog capable of recording source account, calendar month, version/activity, state, object key, heart/calorie counts, timestamp bounds, byte size, plaintext/ciphertext hashes, encryption-key version, error information, verification time, and pruning time. Enforce one active version per source/month without preventing immutable superseded versions.
- Add schema tests for uniqueness, constraints, duplicate semantic-identity detection, and all required catalog/statistics fields.

## Task 2: Canonical normalization, set-based dual writes, and summary finalization

Implement compact ingestion behind reversible flags while preserving current legacy behavior.

- Add stable canonical source metadata normalization and hashing. Irrelevant object key order must not change the hash.
- Resolve or insert one `source_streams` row per canonical metadata hash.
- Batch every imported page into one set-based compact-table upsert per metric. Do not issue one insert per sample.
- Use semantic conflict keys. Identical overlap rows must be counted as unchanged and must not execute an update or create a new tuple version. Corrections at the same semantic identity update exactly one row. Multiple different streams may share a timestamp.
- Return inserted, updated, and unchanged counts for compact writes.
- Preserve civil dates and UTC offsets across DST changes and preserve measured zero calories.
- Dual-write compact rows only when the compact-write feature flag is enabled. Legacy writes remain available for rollback.
- Defer daily-summary recalculation until the final provider page for the affected sync window, then recalculate each affected date once. Failed or partial jobs must not finalize or prune.
- Calculate exact daily heart statistics: resting/min/mean/max, count, coverage, sum, sum of squares, population standard deviation, p05, median, p95, aggregation version, and finalized timestamp.
- Provide a backfill/validation operator command that migrates source streams and compact heart/calorie rows in bounded batches, aborts on duplicate semantic identities, refreshes daily summaries, and compares account/date counts, bounds, sums, minima, maxima, coverage, and percentiles.
- Keep raw deletion disabled. Add tests proving an identical repeated two-day sync performs zero compact updates and summaries finalize once.

## Task 3: Encrypted monthly R2 archive and recovery tooling

Implement the cold archive without making R2 a runtime dependency.

- Add runtime parsing for `HEALTH_ARCHIVE_ENABLED`, `HEALTH_ARCHIVE_S3_ENDPOINT`, `HEALTH_ARCHIVE_S3_REGION` (default `auto`), `HEALTH_ARCHIVE_S3_BUCKET`, `HEALTH_ARCHIVE_S3_ACCESS_KEY_ID`, `HEALTH_ARCHIVE_S3_SECRET_ACCESS_KEY`, and versioned `HEALTH_ARCHIVE_ENCRYPTION_KEYS`.
- Add an R2/S3 adapter with dependency injection for tests. It must never run at startup when disabled and its failures must not fail readiness or normal sync.
- A month is eligible only when its final civil date is at least 90 days old.
- Build deterministic archive contents: `manifest.json`, `source-streams.json`, `heart-rate-samples.csv`, and `calorie-intervals.csv`. Stream/export in a memory-bounded way.
- Compress before AES-256-GCM encryption. Bind format/version metadata as authenticated data. Wrong keys and tampering must fail authentication.
- Use immutable keys `health-hub/raw/v1/YYYY/MM/health-raw-YYYY-MM-<hash>.hharchive`; the hash is the archive content identity. Never overwrite an object and create a new catalog version for a rebuild.
- Before a catalog entry can become `verified`, upload, download the complete object, verify ciphertext hash, authenticate/decrypt, validate the manifest schema/month/source/counts, and validate measurement hashes.
- Only verified months are eligible for bounded, resumable, idempotent pruning. Keep the actual pruning feature default-off and require an explicit enable switch separate from archive creation.
- Record failures in the catalog and retain all PostgreSQL rows.
- Add operator commands to list, verify, extract, and re-import an archive into a caller-selected database. Re-import defaults to refusing a production-looking target unless the operator uses an explicit override.
- Test deterministic schemas, eligibility, crypto round trips, wrong keys, tampering, hash/count/readback failures, interruption/resume, idempotency, and deletion blocking.

## Task 4: Raw availability, archive status, and bounded exports

Expose retention honestly without weakening authentication.

- Extend heart responses with `rawAvailability.retainedFrom`, `requestedRangeFullyRaw`, and `coldArchiveMonth`.
- Recent day views continue to return five-minute points derived from exact samples.
- Aged day views return permanent enhanced daily statistics plus an explicit message that fine-grained measurements are in encrypted cold storage.
- Add authenticated archive-status endpoints for configured state, pending/failed months, last verified month, hot cutoff, and safe catalog metadata. Never expose credentials, encryption material, internal signed URLs, or public object URLs.
- Full export manifests distinguish exact rows included locally, months available in cold archives, and permanent summary-only coverage. Never silently omit unavailable exact detail.
- Replace raw export `LIMIT/OFFSET` paging with stable keyset/cursor streaming and keep memory bounded.
- Weekly/yearly/lifetime calculations combine daily counts, sums, sums of squares, minima, maxima, and coverage. Percentile aggregation must be labeled as daily-distribution based unless exact raw rows are available; do not average daily standard deviations.
- Existing long-range and analysis views continue to use permanent daily summaries.
- Add API, repository, export, and UI tests for recent, mixed, and aged ranges.

## Task 5: Operational safety, configuration, and documentation

Finish the reviewable implementation without crossing protected production gates.

- Add sample configuration and startup validation that is strict only when archive creation is enabled. Never add real secrets.
- Add scheduled archive-worker wiring that is independently disableable, safely serialized, resumable, and observable. Archive failure must be reported but not terminate the app or block sync.
- Document creation of the two private buckets `philippeho-health-hub-raw-archive` and `philippeho-coolify-db-backups`, separate bucket-scoped Object Read/Write tokens, no lifecycle deletion for the archive bucket, an indefinite archive-prefix lock, and unique backup object names.
- Document Coolify backup targets: retain seven local daily copies, thirty R2 daily copies at 03:00, and twelve R2-only monthly copies at 03:30 on day one.
- Add quarterly restore-drill instructions for a Coolify dump and one encrypted archive, including a restore-test record template.
- Document the lifelong retention contract, archive catalog states, credential custody, incident behavior, rollback before/after legacy removal, and every explicit approval gate.
- Add release and runbook commands for backfill, validation, archive list/verify/extract/re-import, and safe dry runs.
- Update the Hetzner migration log only with completed facts; do not claim R2 provisioning, restore success, production cutover, or pruning until each actually happens.
- Run the complete test/build/container checks and inspect the branch for secrets.

## Task 6: External R2 and Coolify setup

Apply only non-destructive production configuration after the code and operator path are verified.

- Use the authenticated Cloudflare browser session if available to create the two exact private bucket names and separate bucket-scoped tokens without exposing token values in chat or logs.
- Store archive credentials and a separately generated versioned AES-256 keyring only in Coolify and the user's password manager. Keep archive and pruning flags disabled initially.
- Register and verify the backup R2 bucket as Coolify S3 storage.
- Preserve the existing seven-copy local 03:00 schedule. Add thirty-copy daily R2 retention and a separate twelve-copy R2-only monthly 03:30 schedule without deleting working backups.
- Run a non-destructive database restore into disposable PostgreSQL and an encrypted archive round-trip into a disposable database. Record evidence.
- If authentication or UI state prevents safe setup, stop this task with exact remaining operator actions. Do not ask for credentials in chat.
- Do not enable compact reads, raw pruning, table renames/drops, or WAL tuning in this task.
