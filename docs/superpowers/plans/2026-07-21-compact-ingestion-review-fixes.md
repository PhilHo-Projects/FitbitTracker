# Compact Ingestion Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct whole-month raw retention, canonical Unicode key ordering, calorie validation completeness, and repeated-sync idempotency coverage identified by Task 2 review.

**Architecture:** Keep the fixes within the existing metric writer, metadata canonicalizer, compact validator, and sync tests. Retention eligibility remains SQL-enforced, canonical ordering uses a locale-independent total string order, calorie validation remains set-based in PostgreSQL, and the acceptance test wraps real writers only to observe returned counts and finalization calls.

**Tech Stack:** Node.js ESM, PostgreSQL 16 SQL, `pg`, `pg-mem`, Node test runner.

## Global Constraints

- Preserve legacy writes, compact opt-in behavior, and job-completion atomicity.
- Raw deletion requires a complete verified archive month ending on or before the cutoff.
- Validation must distinguish total, active, and basal calories and verify permanent daily summaries.
- No production, deployment, server, or external-system changes.
- Follow RED-GREEN TDD and commit without rewriting history.

---

### Task 1: Whole-month retention and canonical ordering

**Files:**
- Modify: `test/metric-ingestion.test.js`
- Modify: `lib/db/metric-writer.js`
- Modify: `test/compact-ingestion.test.js`
- Modify: `lib/metrics/source-metadata.js`

**Interfaces:**
- Preserves: `writer.pruneRawMetricsBefore(sourceAccountId, cutoffDate)`.
- Preserves: `canonicalizeSourceMetadata(metadata)` and `hashSourceMetadata(metadata)`.

- [ ] Add a pruning regression with verified January and April archive rows and cutoff `2026-04-19`; assert January prunes and all April raw rows remain.
- [ ] Run the regression and verify current SQL deletes April 1-18.
- [ ] Require `archive.archive_month + INTERVAL '1 month' <= $2::date` in both deletion joins.
- [ ] Add reversed insertion-order metadata keys `é` and `e\u0301`; assert identical canonical JSON and hashes.
- [ ] Run the test and verify `localeCompare` produces order-dependent output.
- [ ] Replace locale collation with a total comparator: `(left < right ? -1 : left > right ? 1 : 0)`.
- [ ] Run both focused files until green.

### Task 2: Complete calorie validation

**Files:**
- Modify: `lib/db/compact-backfill.js`
- Modify: `test/compact-backfill.test.js`
- Modify: `test/postgres-integration.test.js`

**Interfaces:**
- Preserves: `runCompactHealthOperation({ pool, mode: 'validate' })` returning `{ valid, mismatches }`.

- [ ] Add SQL-contract regressions requiring the calorie mismatch query to join `calorie_daily_summaries`, compare per-type sums, interval count, coverage, total derivation, and expose the summary row.
- [ ] Extend the PostgreSQL acceptance test: corrupt `calorie_daily_summaries.total_kcal` and assert invalid; restore it, swap the compact interval type, and assert invalid again.
- [ ] Run the focused tests and record RED from missing summary/per-type comparisons.
- [ ] Extend both legacy and compact calorie aggregates with `total_kcal`, `active_kcal`, and `basal_kcal` filtered sums.
- [ ] Join permanent daily summaries and compare the legacy-derived total, per-type values, interval count, coverage seconds, and `total_derived` semantics.
- [ ] Restore modified PostgreSQL fixtures between mismatch assertions and confirm the valid baseline remains valid.

### Task 3: Repeated two-day sync acceptance

**Files:**
- Modify: `test/postgres-integration.test.js`

**Interfaces:**
- Uses: `createSyncService`, `createMetricWriter`, `createCompactMetricWriter`, the real sync repository, and an isolated PostgreSQL 16 schema.

- [ ] Add a two-page, two-day gateway fixture that repeats identical provider records for two sequential jobs.
- [ ] Wrap the real compact writer to record actual `{ inserted, updated, unchanged }` results and the real metric writer to record successful `recalculateDaily` calls.
- [ ] Assert first-job compact inserts, second-job `inserted: 0`, `updated: 0`, unchanged counts for every repeated row, and exactly one finalization per affected date per job.
- [ ] Run the acceptance test against PostgreSQL 16; the pg-mem suite cannot exercise this path because it does not parse the compact writer's `jsonb_to_recordset` SQL. If existing behavior is already correct, retain the test as required acceptance coverage and document that no production orchestration change was required.

### Task 4: Verification and evidence

**Files:**
- Modify ignored report: `.superpowers/sdd/task-2-report.md`

- [ ] Run focused ingestion, validation, sync, and PostgreSQL integration tests.
- [ ] Run `npm test` and verify zero failures and pristine output except intentional local real-PG skips.
- [ ] Run `git diff --check`, inspect the complete diff, and commit one follow-up fix without amending prior commits.
- [ ] Append root causes, RED/GREEN commands, test counts, commit hash, and remaining real-PG verification note to the ignored task report.
