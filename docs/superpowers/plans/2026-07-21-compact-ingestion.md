# Compact Health Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reversible compact dual writes, exact final daily heart summaries, and a safe bounded backfill/validation command without changing legacy reads.

**Architecture:** Canonical source metadata and compact PostgreSQL writes live in focused database modules, while the existing metric writer continues all legacy writes and delegates compact writes only when enabled. Sync completion becomes the only finalization boundary, and pruning requires both an explicit flag and verified archive catalog coverage. An operator module uses bounded keyset batches and defaults to validation/dry-run behavior.

**Tech Stack:** Node.js ESM, PostgreSQL 16, `pg`, `pg-mem`, Node test runner.

## Global Constraints

- Name the opt-in dual-write flag `HEALTH_COMPACT_WRITES_ENABLED`; default false.
- Name the deletion gate `HEALTH_RAW_PRUNING_ENABLED`; default false.
- Existing `RAW_RETENTION_DAYS` alone must no longer authorize deletion.
- Never delete unarchived data.
- Preserve current legacy writes and reads for rollback.
- Do not add R2 behavior, deploy production, remove tables/indexes, or cut reads over.
- Backfill is explicit, bounded, dry-run/validation safe, and never deletes source rows.

---

### Task 1: Canonical metadata and compact writer

**Files:**
- Create: `lib/metrics/source-metadata.js`
- Create: `lib/db/compact-metric-writer.js`
- Modify: `lib/metrics/normalizers.js`
- Modify: `lib/db/metric-writer.js`
- Test: `test/compact-ingestion.test.js`
- Test: `test/postgres-integration.test.js`

**Interfaces:**
- Produces: `canonicalizeSourceMetadata(metadata)`, `hashSourceMetadata(metadata)`, and `createCompactMetricWriter(pool)` with heart/calorie set-based upserts returning `{ inserted, updated, unchanged }`.
- Consumes: normalized records carrying `sourceMetadata` and existing compact schema semantic keys.

- [ ] Write tests proving recursive key-order stability, distinct streams at one timestamp, identical-row no-op counts, one-row corrections, DST offsets, zero calories, and one set-based statement per page.
- [ ] Run focused unit and opt-in PostgreSQL tests and verify missing APIs/behavior fail.
- [ ] Implement canonical metadata extraction/hashing, stream resolution, incoming-row duplicate rejection, and JSON-recordset upserts whose conflict updates have an `IS DISTINCT FROM` guard.
- [ ] Wire compact delegation behind `HEALTH_COMPACT_WRITES_ENABLED` while retaining legacy writes.
- [ ] Re-run focused tests until green.

### Task 2: Completion-boundary summary finalization and deletion gates

**Files:**
- Modify: `lib/db/metric-writer.js`
- Modify: `lib/jobs/sync-service.js`
- Modify: `server.js`
- Modify: `test/metric-ingestion.test.js`
- Modify: `test/sync.test.js`

**Interfaces:**
- Produces: `writer.finalizeDailySummaries(sourceAccountId, startDate, endDateExclusive)` and sync options `compactWritesEnabled`/`rawPruningEnabled` supplied from exact environment flags.
- Consumes: completed sync job boundaries and legacy heart/calorie rows.

- [ ] Write failing tests for exact statistics, finalization once after the last successful page/chunk, no finalization on failure/partial jobs, compact flag default-off, pruning default-off, and verified-month-only pruning.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement exact population statistics/continuous percentiles while preserving resting and coverage semantics; finalize only after repository reports the entire job completed.
- [ ] Require `HEALTH_RAW_PRUNING_ENABLED === 'true'` and verified active archive catalog coverage before deletion.
- [ ] Re-run focused tests until green.

### Task 3: Bounded operator backfill and validation

**Files:**
- Create: `lib/db/compact-backfill.js`
- Create: `scripts/compact-health.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Test: `test/compact-backfill.test.js`

**Interfaces:**
- Produces: `runCompactHealthOperation({ pool, mode, execute, batchSize, writer })` and `npm run health:compact -- ...`.
- Consumes: legacy metric rows, compact-writer APIs, and daily-summary finalization.

- [ ] Write failing tests for safe default/dry run, positive bounded batch size, explicit execute requirement, duplicate semantic-identity abort, source preservation, bounded iteration, summary refresh, and aggregate comparison output.
- [ ] Run focused tests and verify expected failures.
- [ ] Implement keyset batches, duplicate detection, compact-only writes, summary refresh, and validation comparisons covering counts, bounds, sums, minima, maxima, coverage, and heart percentiles.
- [ ] Document exact dry-run/backfill/validate invocations and flags.
- [ ] Re-run focused tests until green.

### Task 4: Verification and handoff

**Files:**
- Create: `.superpowers/sdd/task-2-report.md`

- [ ] Run all focused tests, the complete `npm test` suite, and the opt-in PostgreSQL test when `PG_INTEGRATION_URL` is available.
- [ ] Inspect the diff for flag defaults, query cardinality, update guards, deletion safety, legacy behavior, and secrets.
- [ ] Write RED/GREEN evidence, exact commands/results, changed files, review findings, and concerns to the report.
- [ ] Commit the complete Task 2 implementation.
