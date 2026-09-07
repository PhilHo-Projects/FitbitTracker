# SpO₂ Tracker Implementation Plan

> **For agentic workers:** Execute inline, task by task, using `superpowers:executing-plans` when implementation is requested. Do not spawn subagents or create worktrees. Repository `AGENTS.md` and Philippe's current instructions govern execution; this document does not authorize deployment, consent, production backfill, or data-safety gate changes.

**Status:** Proposed plan, written 2026-09-07. No tasks below have been implemented or run. Code blocks are implementation contracts and regression examples, not claims about existing exports or passing tests.

**Goal:** Add a trustworthy nightly SpO₂ tracker with preserved provider data, sleep context, daily trends, and complete selected exports.

**Architecture:** Extend the existing Google Health connector, PostgreSQL sync queue, and authenticated Health Hub. Keep oxygen normalization, persistence, statistics, and presentation in focused modules. Store provider daily records separately from intraday samples and derive the night view using existing sleep intervals.

**Tech stack:** Existing JavaScript ES modules, Node, Express, PostgreSQL/`pg`, `node:test`, pg-mem, Tailwind, DOM/SVG, Sharp, and Archiver. TypeScript snippets in the spec describe contracts only; no TypeScript migration or new runtime dependency.

**Spec:** [SpO₂ tracker design](../specs/2026-09-07-spo2-tracker-design.md). Read both documents before execution. This replaces only the oxygen portion of the September 4 connector plan.

## Global constraints

- Keep every existing compact-write, archive-execution, pruning, read-cutover, table-removal, and PostgreSQL tuning gate disabled unless Philippe explicitly approves the specific gate.
- Work in the existing task-relevant checkout. Do not spawn subagents, reviewers, or parallel agent workflows.
- Exclude `node_modules/`, `.worktrees/`, and `.superpowers/` from recursive searches.
- Never print or commit tokens, credentials, encryption keys, actual personal health fixtures, or raw upstream errors.
- Both upstream oxygen data types use `list`; only intraday oxygen is subject to the existing raw fetch clamp.
- Provider bounds are confidence bounds. Sample min/max are computed separately. Zero is a value, not missing data.
- Normalized percentage storage has no fixed decimal scale; raw timestamp strings and original source JSON are retained.
- All API reads remain authenticated and `no-store`; journal text remains opt-in for exports.
- Existing R2 v1 bundles do not contain oxygen. No gate changes or archive-v1 schema edits belong in this plan.
- Run focused tests per task and one complete release verification cycle. No redundant reviewer agents or repeated full suites.

## File map

| File | Change / responsibility |
|---|---|
| `lib/metrics/oxygen-normalizer.js` | New whole-page validation, provider identity, sample/daily normalization |
| `lib/metrics/oxygen-time.js` | Shared exact timestamp parsing and sample civil-date calculation |
| `lib/metrics/oxygen-statistics.js` | New pure sample selection, duplicate/conflict handling, statistics, plotting segments |
| `lib/db/oxygen-writer.js` | New transactional upserts for two oxygen tables |
| `lib/db/oxygen-repository.js` | New date/session/source read model and metric fetch status |
| `db/migrations/008_oxygen_saturation.sql` | New additive schema; recheck number first |
| `lib/db/metric-writer.js` | Delegate the two oxygen write methods |
| `lib/jobs/planner.js`, `lib/jobs/google-health-request.js` | Metric registrations, chunk windows, operation/filter parity |
| `lib/jobs/sync-service.js` | Oxygen ingestion, previous-evening fetch expansion, partial-failure isolation |
| `lib/jobs/sync-repository.js` | Terminal-failure callback using the existing transaction and claim fencing |
| `scripts/build-n8n-workflow.mjs`, `n8n/health-hub-workflow.json` | Equivalent fallback gateway registrations and regenerated JSON |
| `scripts/sync-backfill.mjs` | Validated optional `--metrics` selection |
| `lib/db/health-repository.js`, `lib/routes/health-routes.js` | Dashboard composition and oxygen route |
| `public/oxygen-ui.js`, `public/app.js`, `public/index.html`, `src/input.css` | Workspace, Today card, date/source controls, accessible SVG/table |
| `lib/exports/oxygen-dataset.js` | New provider daily records, raw sample stream, local availability |
| `lib/exports/dataset.js`, `lib/exports/service.js`, `lib/exports/csv.js`, `lib/exports/png.js` | Oxygen export selection, schema 1.1.0, CSV/JSON/PNG integration |
| `lib/db/fixtures.js`, `test-support/oxygen.js` | Synthetic preview and reusable test fixtures |
| `test/oxygen-normalizer.test.js`, `test/oxygen-ingestion.test.js` | New contract and persistence regressions |
| `test/oxygen-statistics.test.js`, `test/oxygen-repository.test.js`, `test/oxygen-ui.test.js` | New math, read model, UI behavior tests |
| Existing sync/client/workflow/API/export/PNG/PostgreSQL test files | Integration at current boundaries |
| `README.md`, `docs/spo2-runbook.md` | Feature semantics, targeted sync, canary, limitations, rollback |

## Task 1: Establish the upstream contract and normalizers

**Files:** Create `test-support/oxygen.js`, `test/oxygen-normalizer.test.js`, `lib/metrics/oxygen-time.js`, and `lib/metrics/oxygen-normalizer.js`. Reuse `lib/metrics/source-metadata.js`.

**Consumes:** Documented v4 `dataPoints`, the existing `hashSourceMetadata` helper.

**Produces:** `normalizeOxygenSaturationSamples(payload)` → `OxygenSample[]`; `normalizeDailyOxygenSaturation(payload)` → `OxygenDaily[]`, exactly as specified. Contract errors have `code: 'OXYGEN_CONTRACT_INVALID'` and `transient: false` with a fixed safe message.

- [ ] Add deterministic fixture constructors. All data below is invented; no production payload belongs in this helper.

```js
// test-support/oxygen.js
export const oxygenSource = {
  recordingMethod: 'PASSIVELY_MEASURED',
  device: { manufacturer: 'Fixture', displayName: 'Test watch', formFactor: 'WATCH' },
};

export function oxygenPoint({
  id = 'sample-1', time = '2026-09-07T03:59:00Z', percentage = 96.25,
  offset = '-14400s', dataSource = oxygenSource,
} = {}) {
  return {
    name: `users/me/dataTypes/oxygen-saturation/dataPoints/${id}`,
    dataSource,
    oxygenSaturation: { sampleTime: { physicalTime: time, utcOffset: offset }, percentage },
  };
}

export function oxygenDailyPoint({
  id = 'daily-1', date = { year: 2026, month: 9, day: 7 },
  average = 96.25, lower = 93.125, upper = 98.75, sd = 0.7,
  dataSource = oxygenSource,
} = {}) {
  return {
    name: `users/me/dataTypes/daily-oxygen-saturation/dataPoints/${id}`,
    dataSource,
    dailyOxygenSaturation: {
      date, averagePercentage: average, lowerBoundPercentage: lower,
      upperBoundPercentage: upper, standardDeviationPercentage: sd,
    },
  };
}
```

- [ ] Write the central regression before implementation:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { oxygenPoint, oxygenDailyPoint } from '../test-support/oxygen.js';
import {
  normalizeOxygenSaturationSamples as samples,
  normalizeDailyOxygenSaturation as daily,
} from '../lib/metrics/oxygen-normalizer.js';

test('oxygen uses provider identity, local sample date, and distinct confidence fields', () => {
  const point = oxygenPoint();
  const [first] = samples({ dataPoints: [point] });
  const [corrected] = samples({ dataPoints: [oxygenPoint({ percentage: 97.12345 })] });
  assert.equal(first.providerKey, point.name);
  assert.equal(corrected.providerKey, first.providerKey);
  assert.equal(corrected.percentage, 97.12345);
  assert.equal(first.civilDate, '2026-09-06');
  assert.equal(first.utcOffsetSeconds, -14400);
  assert.deepEqual(first.sourceFields, point);
  const [summary] = daily({ dataPoints: [oxygenDailyPoint()] });
  assert.equal(summary.lowerBoundPercentage, 93.125);
  assert.equal(summary.standardDeviationPercentage, 0.7);
  assert.equal(Object.hasOwn(summary, 'minimumPercentage'), false);
});

test('zero is preserved and malformed nonempty responses fail visibly', () => {
  assert.equal(samples({ dataPoints: [oxygenPoint({ percentage: 0 })] })[0].percentage, 0);
  assert.deepEqual(samples({}), []);
  assert.deepEqual(samples({ dataPoints: [], nextPageToken: 'fixture-next' }), []);
  for (const payload of [
    null, [], { result: [] }, { dataPoints: 'wrong' },
    { dataPoints: [oxygenPoint({ percentage: true })] },
    { dataPoints: [oxygenPoint({ percentage: null })] },
    { dataPoints: [oxygenPoint({ percentage: 101 })] },
    { dataPoints: [oxygenPoint({ offset: '' })] },
  ]) {
    assert.throws(() => samples(payload), (e) =>
      e.code === 'OXYGEN_CONTRACT_INVALID' && e.transient === false);
  }
});
```

- [ ] Run `node --test test/oxygen-normalizer.test.js`; expect the missing module/export failure.
- [ ] Implement whole-page envelope and record validation. Use a `Map` keyed by `name`. Compare repeated same-name records canonically; identical repeats collapse and conflicting repeats reject the page. Do not copy heart-rate's value-dependent fallback key or UTC default.

```js
// Key construction inside the normalizer after validation.
const providerId = point.name;
const record = {
  providerKey: providerId,
  providerId,
  sourceKey: hashSourceMetadata(point.dataSource ?? {}),
  sourceMetadata: point.dataSource ?? {},
  sourceFields: point,
};

// Fixed safe failure: never interpolate a point, provider ID, or transport body.
throw Object.assign(new Error('Google Health returned an invalid oxygen record'), {
  code: 'OXYGEN_CONTRACT_INVALID', transient: false,
});
```

- [ ] Add cases for changed timestamp with same provider name, different names/sources at the same timestamp, 100%, decimals, missing daily bounds → null plus `bounds-missing`, supplied inverted bounds, absent optional SD, negative SD, February 30, missing name, invalid token type, and wrong metric payload. Offset tests must include `0s`, `-14400s`, `-18000s`, and missing offset; optional `civilTime` contradictions must fail.
- [ ] Retain the original timestamp string, including fractional digits. Put exact parsing in `oxygen-time.js`: export `oxygenInstantNanoseconds(timestamp)` returning a `bigint`, and `parseOxygenTime(sampleTime)` returning `{ sampledAt, civilDate, utcOffsetSeconds, epochNanoseconds }`. Derive civil date with explicit timestamp+offset arithmetic and calendar checks; do not truncate fractional seconds before checking a date boundary. Include a `23:59:59.999999999Z` case so rounding cannot move a record to tomorrow. Use integer nanoseconds internally and `Date` only after flooring to a civil day; convert no `bigint` directly to JSON. Tasks 4–5 reuse this helper for exact identity/boundary comparisons.
- [ ] Re-run the focused normalizer tests. Expected: every valid sample preserves precision/source fields and every invalid nonempty envelope raises the safe contract error. Commit this independently testable task when implementation is authorized.

## Task 2: Add retained, idempotent oxygen storage

**Files:** Create migration and `lib/db/oxygen-writer.js`, `test/oxygen-ingestion.test.js`; modify `lib/db/metric-writer.js`, `test/db-migrations.test.js`, and the existing PostgreSQL integration tests.

**Consumes:** `OxygenSample[]`, `OxygenDaily[]` from Task 1; existing `deterministicUuid`.

**Produces:** `createOxygenWriter(pool)` with the two upsert methods, exposed unchanged from `createMetricWriter(pool, options)`. No compact-path coupling.

- [ ] Recheck migration numbering using `rg --files db/migrations`. Add the next unused migration; the SQL contract below assumes `008` remains available.

```sql
CREATE TABLE oxygen_saturation_samples (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text NOT NULL,
  source_key text NOT NULL,
  civil_date date NOT NULL,
  sampled_at timestamptz NOT NULL,
  sample_time_text text NOT NULL,
  utc_offset_seconds numeric NOT NULL,
  percentage numeric NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_account_id, provider_key)
);
CREATE INDEX oxygen_samples_time_idx
  ON oxygen_saturation_samples (source_account_id, sampled_at);
CREATE INDEX oxygen_samples_date_idx
  ON oxygen_saturation_samples (source_account_id, civil_date, sampled_at);

CREATE TABLE oxygen_saturation_daily_summaries (
  id uuid PRIMARY KEY,
  source_account_id uuid NOT NULL REFERENCES source_accounts(id) ON DELETE CASCADE,
  provider_key text NOT NULL,
  provider_id text NOT NULL,
  source_key text NOT NULL,
  civil_date date NOT NULL,
  average_percentage numeric NOT NULL
    CHECK (average_percentage >= 0 AND average_percentage <= 100),
  lower_bound_percentage numeric
    CHECK (lower_bound_percentage >= 0 AND lower_bound_percentage <= 100),
  upper_bound_percentage numeric
    CHECK (upper_bound_percentage >= 0 AND upper_bound_percentage <= 100),
  standard_deviation_percentage numeric CHECK (standard_deviation_percentage >= 0),
  quality_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (lower_bound_percentage IS NULL OR upper_bound_percentage IS NULL
    OR lower_bound_percentage <= upper_bound_percentage),
  UNIQUE (source_account_id, provider_key)
);
CREATE INDEX oxygen_daily_date_idx
  ON oxygen_saturation_daily_summaries (source_account_id, civil_date, source_key);
```

- [ ] Write a pg-mem ingestion test using the existing `applyMigrations` and `seedFixtures` pattern. A concrete core of the test:

```js
// pool is a fresh migrated pg-mem Pool; accountId is selected from the seeded fixture account.
const writer = createMetricWriter(pool);
const initial = normalizeOxygenSaturationSamples({ dataPoints: [oxygenPoint()] });
await writer.upsertOxygenSaturationSamples(accountId, initial);
await writer.upsertOxygenSaturationSamples(accountId, initial);
await writer.upsertOxygenSaturationSamples(accountId,
  normalizeOxygenSaturationSamples({ dataPoints: [oxygenPoint({ percentage: 97.12345 })] }));
const stored = (await pool.query(
  'SELECT percentage, source_fields FROM oxygen_saturation_samples WHERE source_account_id = $1',
  [accountId],
)).rows;
assert.equal(stored.length, 1);
assert.equal(Number(stored[0].percentage), 97.12345);
assert.equal(stored[0].source_fields.oxygenSaturation.percentage, 97.12345);
```

- [ ] Run `node --test test/oxygen-ingestion.test.js`; expect missing tables/methods before implementing the writer.
- [ ] Implement page transactions with `BEGIN`, parameterized upsert, `COMMIT`, `ROLLBACK`, and `finally release()`. Assign deterministic IDs using namespaces `oxygen-sample` and `oxygen-daily`. Conflict updates include source key, date/time/offset, all numeric fields, source metadata/JSON, and updated timestamp. Daily updates replace optional bounds/SD with null when the latest record omits them, instead of retaining stale values.

```js
// createMetricWriter: compose rather than embedding oxygen SQL in the existing large module.
const oxygenWriter = createOxygenWriter(pool);
return {
  ...oxygenWriter,
  // Existing sleep/heart/calorie methods remain here.
};
```

- [ ] Test both tables for account isolation, timestamp/date correction, identical retry, distinct provider identities, and empty-page no-op. Add a transaction failure test ensuring the first row is rolled back if the second insert fails. Confirm that enabling the already-existing compact option in a test does not route oxygen to a compact table.
- [ ] Add a real-PostgreSQL integration case in the existing generated-schema harness for unconstrained decimal precision, null checks, unique constraints, timestamp text with nine fractional digits, and non-default session timezone. Avoid changing the harness's schema isolation or drop validation.
- [ ] Run `node --test test/oxygen-ingestion.test.js test/db-migrations.test.js`; use the real PostgreSQL case during Task 8's final integration pass. Expected: corrected record count stays one, original timestamp text survives, old migrations still work. Commit the storage slice.

## Task 3: Integrate both metrics with sync and gateway fallback

**Files:** Modify planner, request builder, sync service/repository, workflow generator/generated JSON, backfill script, and `test/sync.test.js`, `test/sync-backfill.test.js`, `test/google-health-client.test.js`, `test/workflow.test.js`.

**Consumes:** Task 1 normalizers and Task 2 writer methods.

**Produces:** Both oxygen metrics accepted end-to-end; metric-selective CLI; terminal job outcomes that preserve unrelated successful metrics.

- [ ] Add failing registrations/filter assertions before modifying production code:

```js
for (const [metric, field] of [
  ['oxygen-saturation', 'oxygen_saturation.sample_time.civil_time'],
  ['daily-oxygen-saturation', 'daily_oxygen_saturation.date'],
]) {
  assert.ok(GOOGLE_HEALTH_METRICS.includes(metric));
  const request = buildGoogleHealthRequest({
    metric, operation: 'list', startDate: '2026-09-06', endDateExclusive: '2026-09-08',
    pageToken: 'fixture-token',
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('filter'),
    `${field} >= "2026-09-06" AND ${field} < "2026-09-08"`);
  assert.equal(url.searchParams.get('pageToken'), 'fixture-token');
  assert.equal(url.searchParams.get('pageSize'), '10000');
  assert.equal(url.searchParams.has('startTime'), false);
}
```

- [ ] Run `node --test test/sync.test.js test/google-health-client.test.js`; confirm the oxygen cases fail, then register 14-day sample windows, 90-day daily windows, both `list` operations, and their exact filters. Add intraday only to `RAW_SYNC_METRICS`.
- [ ] Add ingestion branches before the current calorie fallback. Pass `response.data` directly: the existing shared `response.data ?? {}` fallback would incorrectly turn null/missing gateway data into a successful empty oxygen page. Add a regression for that case.

```js
} else if (chunk.metric === 'oxygen-saturation') {
  await writer.upsertOxygenSaturationSamples(
    chunk.source_account_id, normalizeOxygenSaturationSamples(response.data));
} else if (chunk.metric === 'daily-oxygen-saturation') {
  await writer.upsertDailyOxygenSaturation(
    chunk.source_account_id, normalizeDailyOxygenSaturation(response.data));
```

- [ ] In `enqueue`, retain validation of the user's requested range. For oxygen only, set the metric start to one day before that range, clamped to configured raw eligibility. Keep old metric starts and all end dates unchanged. For a request starting at the raw floor, expansion stops at that floor. Cover these exact cases:

| Request / policy | Sample fetch start | Daily fetch start |
|---|---|---|
| Recent `2026-09-01` through exclusive `2026-09-08`, no conflicting cutoff | `2026-08-31` | `2026-09-01` |
| Backfill beginning `2024-01-01`, raw floor `2026-06-10` | `2026-06-10` | `2024-01-01` |
| Custom beginning `2026-06-10`, raw floor `2026-06-10` | `2026-06-10` | `2026-06-10` |
| Custom beginning `2026-06-09`, raw floor `2026-06-10`, includes intraday | Reject 400 before queue creation | No job |

- [ ] Add retry tests with two pages, repeated delivery, empty page with continuation, and failed second page. No successful-window state may appear until the complete chain finishes. Add mixed jobs where oxygen returns 403 but heart/sleep/calories succeed, covering both orders: oxygen fails before the final successful chunk, and oxygen is the final chunk to fail. Both jobs remain `completed_with_errors`; successful pre-existing metrics must still finalize.
- [ ] Extract service-local `finalizeNonOxygenSummaries({ client, jobStatus, jobId, completedChunkId = null })` from the current completion callback. Query every requested non-oxygen chunk; treat only `completedChunkId` as provisionally completed. Recalculate existing summaries only for a terminal job whose non-oxygen set is nonempty and fully successful. For `completed`, also skip unrelated recalculation on an oxygen-only job. Do not mark the oxygen error successful and do not relax finalization when a heart/calorie/sleep page failed.

```sql
-- Inside the existing terminal transaction; $1 is job ID.
SELECT metric, status, id FROM sync_chunks
WHERE sync_job_id = $1
  AND metric NOT IN ('oxygen-saturation', 'daily-oxygen-saturation');
```

- [ ] Extend `failChunk`'s existing options with optional `beforeCommit`. Invoke it only after the fenced failure update succeeds, retry is false, and no pending chunks remain, before committing the terminal job state. Keep stale-claim rejection and rollback behavior intact. In the service, use the same finalizer for both repository paths:

```js
// completeChunk options
beforeCommit: ({ client, jobStatus }) => finalizeNonOxygenSummaries({
  client, jobStatus, jobId: chunk.sync_job_id, completedChunkId: chunk.id,
})

// failChunk options, alongside the existing retryable/maxAttempts/delayMs fields
beforeCommit: ({ client, jobStatus }) => finalizeNonOxygenSummaries({
  client, jobStatus, jobId: chunk.sync_job_id,
})
```

The failure callback receives `jobStatus: 'completed_with_errors'`. A finalization exception rolls back that terminal transaction; do not swallow it. Add a stale-claim test proving neither finalizer is invoked when the claim token no longer owns the chunk.

- [ ] Update generator arrays and filter maps, regenerate `n8n/health-hub-workflow.json`, and use the existing VM-based workflow tests to compare the two oxygen requests with the direct builder. No new node/credential is required. Before editing its embedded Code node JavaScript, consult the installed `n8n-code-javascript` skill. Do not publish/import the workflow during local implementation.
- [ ] Extend the CLI argument parser to accept exactly two positional dates and an optional `--metrics=a,b`. Default invocation behavior stays intact. Extend `runBackfill` dependency-injected tests to assert the selected metrics reach the job; unknown metrics, empty lists, duplicate flags, and extra positional arguments fail before gateway construction.

```text
# Syntax after this task; these examples describe future execution, not permission to run it now.
npm run sync:backfill -- 2026-09-01 2026-09-08 --metrics=oxygen-saturation,daily-oxygen-saturation
npm run sync:backfill -- 2024-01-01 2026-09-08 --metrics=daily-oxygen-saturation
```

- [ ] Run `node --test test/sync.test.js test/sync-backfill.test.js test/google-health-client.test.js test/workflow.test.js`. Expected: pagination/checkpointing, both transports, cutoff boundaries, and mixed failure tests pass. Commit generator and generated JSON together.

## Task 4: Implement source-aware sample statistics

**Files:** Create `lib/metrics/oxygen-statistics.js`, `test/oxygen-statistics.test.js`.

**Consumes:** Task 1 normalized samples and a physical sleep window.

**Produces:** `summarizeOxygenSamples(samples, window)` returning the spec's `OxygenSampleSummary`; `buildOxygenSegments(samples, { gapSeconds = 120, maxPoints = 1200 } = {})` returning `{ segments, reduced, duplicateCount, conflictCount }` for one preselected source. A segment is an array of the original normalized samples, in time order.

- [ ] Write a small explicit dataset that separates real samples from elapsed sleep time:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { oxygenPoint } from '../test-support/oxygen.js';
import { normalizeOxygenSaturationSamples } from '../lib/metrics/oxygen-normalizer.js';
import { summarizeOxygenSamples, buildOxygenSegments } from '../lib/metrics/oxygen-statistics.js';

test('oxygen statistics count observed minutes and preserve a real gap', () => {
  const samples = normalizeOxygenSaturationSamples({ dataPoints: [
    oxygenPoint({ id: 'a', time: '2026-09-07T04:00:00Z', percentage: 98 }),
    oxygenPoint({ id: 'b', time: '2026-09-07T04:01:00Z', percentage: 96 }),
    oxygenPoint({ id: 'c', time: '2026-09-07T04:05:00Z', percentage: 94 }),
  ] });
  const result = summarizeOxygenSamples(samples, {
    startTime: '2026-09-07T04:00:00Z', endTime: '2026-09-07T04:06:00Z',
  });
  assert.equal(result.sampleCount, 3);
  assert.equal(result.averagePercentage, 96);
  assert.equal(result.minimumPercentage, 94);
  assert.equal(result.maximumPercentage, 98);
  assert.equal(result.medianPercentage, 96);
  assert.equal(result.observedMinuteCount, 3);
  assert.equal(result.sleepWindowMinuteCount, 6);
  assert.equal(result.observedMinuteFraction, 0.5);
  assert.equal(result.gapCount, 1);
  assert.equal(result.longestGapSeconds, 240);
  assert.deepEqual(buildOxygenSegments(samples).segments.map((s) => s.length), [2, 1]);
});
```

- [ ] Run `node --test test/oxygen-statistics.test.js`; expect missing exports.
- [ ] Implement ordering/filtering by the physical closed-open window, canonical exact timestamp grouping, identical-observation collapse, conflict detection, and sample statistics. Date parsing for chart coordinates must not determine provider identity. Preserve original timestamp precision when grouping duplicate observations.

```js
// Straight-line segment predicate after conflict groups have split the series.
const connected = nextTimeMs - previousTimeMs <= gapSeconds * 1000;
// Mean is over actual selected observations, never the duration between endpoints.
const averagePercentage = values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;
```

- [ ] Implement observed UTC minute sets intersecting the window. Count bucket intersections for partial boundary minutes. Return null sleep denominator/ratio from the repository's calendar-day fallback rather than inventing a sleep window there.
- [ ] Split gaps/conflicts before reducing large series; retain first/min/max/last observations in each chronological bucket. Return `reduced: true` if points were removed. Reduction must not affect `summarizeOxygenSamples`. The reading table/export can still access unreduced records.
- [ ] Add tests for empty arrays, one sample, explicit zero, exactly 120s versus 121s gaps, duplicate same-value timestamps, contradictory timestamps, end exclusion, midnight, DST repeated civil hour, a fractional boundary minute, and 10,000-point reduction with an isolated low reading preserved. No test should require an assumed one-minute upstream cadence.
- [ ] Run `node --test test/oxygen-statistics.test.js`; expect correct empty/null and statistical cases without database dependencies. Commit this pure feature slice.

## Task 5: Build the oxygen read model and authenticated API

**Files:** Create `lib/db/oxygen-repository.js`, `test/oxygen-repository.test.js`; modify `lib/db/health-repository.js`, `lib/routes/health-routes.js`, `test/health-repository.test.js`, `test/api.test.js`, and PostgreSQL integration coverage.

**Consumes:** Two oxygen tables, existing sleep/session tables and queue status, Task 4 pure functions.

**Produces:** `createOxygenRepository(pool).getDay(accountId, date, selection)` and `.getRange(accountId, range, selection)` → spec response shapes; `createHealthRepository` exposes `getOxygenRange(startDate, endDateExclusive, resolution, selection)` for the router.

- [ ] Add synthetic repository tests for a sleep session that begins at 23:00 local on September 6 and ends at 07:00 local on September 7. Insert samples before midnight, after midnight, and exactly at the exclusive session end. Assert the first two appear and the last does not. Give the provider daily summary a confidence lower bound of 94 while a real sample is 92; assert both are kept under different field names.
- [ ] Run `node --test test/oxygen-repository.test.js test/api.test.js`; confirm the missing oxygen method/route cases fail.
- [ ] Select sleep with account/date scoping and deterministic tie break. Query sample records by physical interval; retain original text for response/export and use numeric projections explicitly.

```sql
SELECT id, start_time, end_time, start_offset_seconds, end_offset_seconds
FROM sleep_sessions
WHERE source_account_id = $1 AND civil_date = $2 AND is_nap = false
ORDER BY duration_seconds DESC, id
LIMIT 1;

SELECT * FROM oxygen_saturation_samples
WHERE source_account_id = $1 AND sampled_at >= $2 AND sampled_at < $3
ORDER BY sampled_at, provider_key
LIMIT 50001;
```

- [ ] Recheck borderline sub-microsecond samples against original timestamp text if an indexed PostgreSQL timestamp could round across an exact session boundary. In the sample SQL above, bind bounds expanded by one microsecond on each side and apply the final closed-open comparison using exact timestamp arithmetic. Keep the 50,001-row guard on the fetched result. Do not exclude a real pre-boundary record because the index projection rounded forward.
- [ ] Fetch daily candidates separately using provider civil date. Group metadata keys; allow independent daily/sample selectors. With multiple source groups and no selector, return `source-selection-required` and candidates rather than blended numbers. For multiple daily records within one selected group/date, set that day's summary null and expose ambiguity. With one group, auto-select it. Unknown source parameters return 400; no account IDs are accepted from the browser.
- [ ] Implement `getRange` from daily rows only, materializing all requested dates. Compute equal-weight averages of non-null unambiguous summaries and counts. A sample-only day has no fabricated daily value. Limit to 366 days and reject unknown resolutions instead of silently coercing them.
- [ ] Implement fetch completeness by grouping job chunks into metric/windows and requiring all pages completed with a terminal empty continuation. Merge completed civil windows to cover the needed range. Expose a newer failure or in-progress attempt separately. Do not use global `sync.lastSuccessfulSync` as oxygen proof. Unit-test the interval union with two adjacent successful chunks, a gap between chunks, and an incomplete final page.
- [ ] In `getDay`, call the Task 4 statistics and segment functions once for the selected sample group. Map both full samples and reduced `plot.segments` to the public sample shape, stripping source JSON. Return `plot.reduced` and `plot.gapSeconds` explicitly. Compose `oxygenSaturation` into the Today payload as a compact projection; do not attach samples/plot/stages/source JSON. Add a null/empty projection for the no-source-account case. Keep `coverage.oxygen` separate from the old heart 20-hour criterion; use oxygen data states rather than forcing `complete` for sensor coverage.

```js
router.get('/metrics/oxygen', handler(async (req, res) => {
  const { startDate, endDateExclusive } = rangeFrom(req.query);
  const resolution = req.query.resolution ?? 'day';
  // getOxygenRange validates strict dates, <=366 days, one day for night, and selectors.
  const data = await repository.getOxygenRange(startDate, endDateExclusive, resolution, {
    sampleSource: req.query.sampleSource,
    dailySource: req.query.dailySource,
  });
  res.json({ ok: true, data });
}));
```

- [ ] Include cases for no account, no sleep, only summary, only samples, none fetched, successful empty fetch, page failure with saved rows, multiple sources, escaped malicious device labels, DST spring/fall nights, historical profile timezone change, cutoff-truncated preceding evening, and >50,000 records → 413. Existing auth middleware must deny anonymous reads and responses must omit private source JSON.
- [ ] Run `node --test test/oxygen-repository.test.js test/health-repository.test.js test/api.test.js`. Add PostgreSQL coverage for new SQL/date behavior to the existing isolated harness for Task 8. Commit the API/read-model slice.

## Task 6: Add the Today card and SpO₂ workspace

**Files:** Create `public/oxygen-ui.js`, `test/oxygen-ui.test.js`; modify `public/index.html`, `public/app.js`, `src/input.css`, `lib/db/fixtures.js`, and relevant layout tests.

**Consumes:** `OxygenDay`, `OxygenRange` from Task 5.

**Produces:** `renderOxygenNight(data)` and `renderOxygenTrend(data)` returning escaped HTML/SVG; `oxygenAxisDomain(values)` returning `{ min, max }`; integrated `loadOxygenWorkspace()` in `app.js`.

- [ ] Add fixture scenarios to the existing fixture-only database seeding: one complete-looking observed series with a gap, one summary-only date, one sample-only date, one empty date, and one multiple-source date. Seed deterministically/idempotently with invented percentages. Keep the local-development banner and fixtures isolated from production mode.
- [ ] Write UI behavior tests before markup. Example minimum contract:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { oxygenAxisDomain, renderOxygenTrend } from '../public/oxygen-ui.js';

test('oxygen axis cannot hide readings below the default range', () => {
  assert.deepEqual(oxygenAxisDomain([96.2, 97]), { min: 85, max: 100 });
  assert.deepEqual(oxygenAxisDomain([82.1, 96]), { min: 80, max: 100 });
  assert.deepEqual(oxygenAxisDomain([0, 96]), { min: 0, max: 100 });
});

test('missing daily summaries remain explicit in trend presentation', () => {
  const html = renderOxygenTrend({
    startDate: '2026-09-06', endDateExclusive: '2026-09-08', timezone: 'America/Toronto',
    days: [
      { date: '2026-09-06', dailySummary: null, dataState: 'empty' },
      { date: '2026-09-07', dailySummary: { averagePercentage: 96.2,
        lowerBoundPercentage: 94, upperBoundPercentage: 98 }, dataState: 'summary-only' },
    ],
    dailySources: [], selectedDailySource: null,
    periodSummary: { averageDailyPercentage: 96.2, daysWithSummary: 1, requestedDays: 2, missingDays: 1 },
    sync: {},
  });
  assert.match(html, /96\.2/);
  assert.match(html, /1 of 2/);
  assert.match(html, /No daily summary/);
});
```

- [ ] Run `node --test test/oxygen-ui.test.js`; expect missing module failure. Implement pure renderers with escaped strings, finite-number checks, accessible headings/table, and the spec's gap/axis rules. Consume `data.plot.segments` and `data.plot.reduced` from the backend; do not duplicate reduction/statistical definitions in the browser.
- [ ] Add navigation `data-nav="oxygen"`, Today `data-open-view="oxygen"`, a `view-oxygen` section, date controls within that section, and Night/7/30/Year tabs. Add `oxygen: 'day'` to range state and map it to existing `dateRangeForPreset` for the nightly request. Preserve date when entering from Today or Sleep.

```js
// Loading integration shape. Keep the existing fetchJson response unwrapping convention.
const requestVersion = ++state.oxygenRequestVersion;
const range = dateRangeForPreset(state.ranges.oxygen, state.selectedDate);
const query = new URLSearchParams({
  start: range.startDate,
  end: range.endDateExclusive,
  resolution: state.ranges.oxygen === 'day' ? 'night' : 'day',
});
if (state.ranges.oxygen === 'day' && state.oxygenSampleSource) {
  query.set('sampleSource', state.oxygenSampleSource);
}
if (state.oxygenDailySource) query.set('dailySource', state.oxygenDailySource);
const data = await fetchJson(`/api/metrics/oxygen?${query}`);
if (requestVersion !== state.oxygenRequestVersion) return;
```

- [ ] Render provider statistics and observed statistics in separate blocks. Use the confidence band only for provider daily trends; nightly sample min/max never use those bounds. Source selectors re-request the selected source. Invalidated source selection after a date change clears gracefully and shows a new chooser.
- [ ] Add the sleep-stage lane, shared physical x-axis, date/offset tooltips, explicit missing intervals, and a paged reading table for unreduced observations. Never embed journal text in the workspace; links to Journal preserve date through application state. Show the brief wellness note and device help disclosure from the spec.
- [ ] Prevent stale response overwrites on date/source/range changes and sync refresh. Loading/errors keep selected controls and previously saved data where appropriate. Provide safe error-specific messaging for 400, 403-equivalent sync state, and oversized detail.
- [ ] Run `node --test test/oxygen-ui.test.js test/health-ui.test.js test/responsive-css.test.js test/sleep-layout.test.js`. Use `npm run dev:fixtures` for manual visual checks at 375px and 1440px, including keyboard navigation, tap tooltips, reduced chart, and empty/partial/multi-source states. Follow the browser skill if automating the visual check. Stop only the fixture process started for this work. Commit the UI slice.

## Task 7: Include oxygen in analysis, full, and PNG exports

**Files:** Create `lib/exports/oxygen-dataset.js`; modify existing export dataset/service/CSV/PNG modules, `public/app.js`, export selection markup, and `test/exports.test.js`, `test/png-layout.test.js`.

**Consumes:** Oxygen tables, source/date rules and range projection from Task 5.

**Produces:** `createOxygenDataset(pool)` exposing `dailyRows(accountId, range)`, `streamSamples(accountId, range)`, and `availability(accountId, range)`. The first is an array of all original daily records mapped to export keys; the second an async iterable; the third returns local bounds/count and `coldArchiveSupported: false`.

- [ ] Add a failing export case selecting `metrics: ['oxygen']` with invented data. Assert that analysis JSON contains provider daily records and full ZIP contains the two oxygen CSVs. Add a regression with a source's lower confidence bound 94 and observed minimum 92 to prevent column mislabeling.

```js
// Assertions within the existing export harness after reading its generated ZIP.
assert.equal(manifest.schemaVersion, '1.1.0');
assert.equal(manifest.units.oxygenSaturation, 'percent');
assert.ok(manifest.files.some((entry) => entry.name === 'oxygen-saturation-daily.csv'));
assert.ok(manifest.files.some((entry) => entry.name === 'oxygen-saturation-samples.csv'));
assert.equal(manifest.rawCoverage.oxygen.coldArchiveSupported, false);
assert.match(dailyCsv, /lower_bound_percentage/);
assert.doesNotMatch(dailyCsv, /minimum_percentage/);
assert.match(samplesCsv, /sampled_at_utc/);
```

- [ ] Run `node --test test/exports.test.js`; expect unsupported oxygen selection. Add `oxygen` to both export allow-lists, the UI's current explicit metrics array, and the dataset. Set `schemaVersion: '1.1.0'` for newly generated outputs and update existing version assertions deliberately.
- [ ] Implement daily CSV column definitions: provider key/ID, source key, civil date, reported average, lower/upper confidence bounds, historical standard deviation, quality flags, source metadata, source fields. Implement sample CSV columns: provider key/ID, source key, civil date, original sampled UTC text, offset seconds, percentage, source metadata, source fields. No derived min/max column belongs in the provider-daily CSV.

```js
// Example additions to EXPORT_COLUMNS; include the complete columns listed above.
'oxygen-saturation-samples.csv': [
  { key: 'providerKey', label: 'provider_key' },
  { key: 'providerId', label: 'provider_id' },
  { key: 'sourceKey', label: 'source_key' },
  { key: 'civilDate', label: 'civil_date' },
  { key: 'sampledAt', label: 'sampled_at_utc' },
  { key: 'utcOffsetSeconds', label: 'utc_offset_seconds', unit: 'seconds' },
  { key: 'percentage', label: 'percentage', unit: 'percent' },
  { key: 'sourceMetadata', label: 'source_metadata' },
  { key: 'sourceFields', label: 'source_fields' },
],
```

- [ ] Stream full samples in account-scoped keyset batches ordered by indexed time and ID, preserving all records. Do not load an entire raw backfill into memory. Filter raw export on sample civil date; daily export on provider date. Add a manifest explanation of why a night chart can begin before a one-day export range. The export action from Night preselects the preceding civil date through the day after the selected date.
- [ ] Build `daily-summary.csv` from the union of existing summary dates and oxygen daily dates so oxygen-only days are not dropped. Append provider average/bounds/state columns and populate nulls when another metric-only export is selected. Analysis JSON keeps all daily candidates and flags; full exports never discard a source because the UI selected another.
- [ ] Add `rawCoverage.oxygen` independently of the existing R2 reader. Include exact local retained bounds/count, the applicable fetched-window completeness, and `coldArchiveSupported: false`. Do not report a verified heart/calorie month as cold oxygen coverage. Preserve existing `rawCoverage` keys for existing consumers.
- [ ] Extend PNG rendering for oxygen selection: four metric summary panels across x=80, 440, 800, 1160 with narrower typography; keep the 1600×1000 output. Use columns for date/sleep/heart/calories/SpO₂ and decimal percent formatting. Limit recent rows as the current PNG does; include days measured and source ambiguity where needed. Do not print missing readings as 0%. Keep non-oxygen PNG output backward-compatible in content.
- [ ] Run `node --test test/exports.test.js test/png-layout.test.js`. Check a summary-only export, oxygen-only dates, all four metrics, no data, zero, duplicate sources, long range, and a nine-fraction timestamp. Render a synthetic PNG and inspect that labels/columns fit. Commit the export slice.

## Task 8: Verify the complete feature and prepare a bounded live canary

**Files:** Add `docs/spo2-runbook.md`; update README and any final regression tests needed by earlier changes. This task's production steps are a future release checklist, not executed by this planning task.

**Consumes:** All earlier tasks.

**Produces:** One verified feature commit sequence, a specific release candidate, and a canary report containing only safe structural/aggregate evidence.

- [ ] Run a final requirement review against A1–A12 in the spec, inline. Fix concrete omissions without reviewer agents or unrelated refactors.
- [ ] Document metric names, permission scope, previous-evening rule, configured raw fetch clamp, source handling, confidence bounds, export semantics, and the lack of oxygen R2 support. Document that a daily average cannot prove individual samples exist.
- [ ] Execute the one complete release cycle. The generator has no `--check` mode; use a byte comparison against the checked-in generated output. Each PowerShell line below is a separate action; stop on failure.

```powershell
npm test
npm run build
$oxygenWorkflowBefore = (Get-FileHash -LiteralPath 'n8n/health-hub-workflow.json' -Algorithm SHA256).Hash
npm run build:workflow
$oxygenWorkflowAfter = (Get-FileHash -LiteralPath 'n8n/health-hub-workflow.json' -Algorithm SHA256).Hash
if ($oxygenWorkflowBefore -ne $oxygenWorkflowAfter) { throw 'Generated workflow was not current' }
git diff --check
```

- [ ] Include real PostgreSQL tests by configuring the existing `PG_INTEGRATION_URL` for a local/test database before that cycle. Do not print it. Confirm the existing harness creates its generated isolated schema. If it is unavailable, report the skipped tests explicitly and run that missing check once against a proper test database before release; do not present pg-mem as PostgreSQL verification.
- [ ] Inspect the fixture UI and export PNG if final changes affect rendering. Retain a compact checklist of sizes and states examined; do not run redundant full suites after unchanged visual inspection.
- [ ] Before any release, inspect the actual live application, its current connector mode, and pending jobs. The old promotion document is dated July and cannot establish September's deployment state. Identify the Coolify resource by the live app; do not guess a UUID from another project. Existing instructions require Hetzner only and the laptop-specific SSH identity.
- [ ] For the account-specific contract check after implementation, use the existing authenticated gateway in process for a recent date known to have sleep. Request intraday over the preceding day and selected day; request daily over the selected day. Follow all pages. The health requests are reads and do not enqueue an ingest job. The existing connector can refresh its own token normally; never extract or print it. Report only HTTP class, property names, record counts, source-group counts, cadence summary, and whether confidence fields exist. Invent or anonymize all values before making reusable fixtures.
- [ ] If an observed response contradicts the contract, update the normalizer fixture/spec and run its affected tests before ingestion. If responses are empty but valid, the summary-only/empty feature remains valid; do not claim the account has intraday data. If consent is absent, record the reconnect requirement for Philippe and finish all independent local checks.
- [ ] Once a concrete release is authorized, deploy the additive migration and code through the established manual-release path. For n8n mode/fallback, ensure the reviewed generated workflow is available before scheduling oxygen jobs. Do not change the connector mode, consent configuration, or other production gates as a shortcut.
- [ ] Queue exactly one recent metric-selective canary job after release. Select dates from actual recent sleep, not the historical example command. Confirm terminal status for every page, sample/daily table counts, source separation, and matching UI/export values without copying personal readings into logs. Repeat that bounded fetch once to prove stored counts are idempotent; this is the live correction/idempotency check, not a second full release suite.
- [ ] Measure approximate bytes per imported sample and confirm the new tables fall under the application's existing database backup/restore process. Keep raw fetch eligibility unchanged. Then, if authorized by the implementation/release request, enqueue daily-only history from the source account's recorded membership date and a bounded intraday backfill within the existing cutoff. Do not run the CLI's default all-metric backfill for an oxygen-only task.
- [ ] Rollback procedure: stop the worker while changing app versions; return to the prior image if needed and retain the additive tables. Inspect pending oxygen jobs before restarting an older worker that cannot understand them; pause/requeue those specific jobs through a reviewed operator action rather than letting unsupported work affect the normal queue. Leave health rows and all archive gates intact. No table drop or data restore is needed for an additive feature rollback.

## Definition of done and evidence record

Implementation is complete when A1–A12 pass, expected UI/export states have been inspected, and the documents describe any account-specific availability limits accurately. A local implementation may be complete while deployment is still pending; label those separately.

Record these facts in the eventual handoff:

| Evidence | What to record |
|---|---|
| Code | Release commit and changed modules |
| Automated checks | Actual test result, integration pass/skip, build, generator equality, diff check |
| Visual checks | 375px/1440px states and generated 1600×1000 PNG inspected |
| Live provider | Whether daily/intraday records were actually observed, without raw personal data |
| Canary | Job outcome, page completion, idempotent counts, no payloads or secrets |
| Storage | Raw clamp unchanged, additive rows retained, oxygen cold archive unsupported |
| Remaining action | Specific consent, deployment, or separate archive decision if still required |

The immediate deliverables of the overnight request are this plan and its linked spec. Future execution defaults to inline work in the existing checkout.
