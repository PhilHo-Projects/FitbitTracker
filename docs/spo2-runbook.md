# SpO₂ implementation and release runbook

The September 14 ingestion/recovery release `6684350` is live through the direct Google connector. Coolify deployment `dnimvesetinovvoljni2hiw2` finished, migration 010 is applied, and readiness returns HTTP 200. The owner-approved plan authorizes two manual application releases and historical recovery from the earliest retained sleep date through the current date, after a two-day canary. OAuth consent remains an owner action; connector mode, scopes, weekly reconnection, retention, and storage gates remain unchanged.

## Current recovery checkpoint — September 14, 2026

Google consent expired with `invalid_grant` on September 13 and the owner reconnected before the September 14 structural inspection. A bounded September 11–14 (exclusive) read returned HTTP 200 and complete single pages: three unnamed daily oxygen records, 828 unnamed oxygen samples, and three respiratory summaries. Only field shapes, counts, and identity properties were recorded; no personal readings were copied into fixtures or logs.

The respiratory summaries had one shared incomplete resource name, `users/<redacted>/dataTypes/respiratory-rate-sleep-summary/dataPoints/`, despite three distinct sample instants and provider dates. Each record normalized individually; the combined page reproduced `Conflicting sleep vital identity`. The repair treats only this exact collection-path shape as unnamed, deriving identity from metric, source, and exact instant. Valid names and true conflicting duplicate errors remain intact. Full/stage statistics and original civil-time payloads remain retained summaries. A synthetic fixture reproduces the observed structure, and PostgreSQL checks separate dates, correction replacement, and unchanged raw JSON.

Safe aggregate checks on September 13 found:

| Metric | Retained observations / coverage |
| --- | --- |
| Main sleep history | 78 distinct dates, June 24–September 12, 2026 |
| Daily HRV and HRV samples | 10 observed dates, September 3–12 |
| Daily respiratory rate and sleep temperature | 10 observed dates, September 3–12 |
| Daily and sampled oxygen | No retained rows; rejected ingestion, not evidence of an empty provider stream |
| Respiratory sleep summaries | No retained rows; rejected ingestion, not evidence of an empty provider stream |

Migration 010 permits null provider IDs for unnamed oxygen records, adds durable reconnect generation/recovery intent, and adds stream error codes and HTTP status. Names that are present are preserved. Unnamed identity uses metric, source, and provider civil date or exact instant; original payloads, precision, and correction behavior are retained.

Disconnected direct connectors suspend scheduling and claims, retain pending work and historical errors, and return actionable `GOOGLE_RECONNECT_REQUIRED` to manual sync. Recovery is deduplicated by consent generation. If another job is active, the durable intent stays pending while that work resumes; the worker then queues recovery, retrying enqueue failures at most once per minute. A queue failure cannot roll back OAuth consent.

Recovery metrics are sleep, daily resting heart rate, both oxygen streams, and the five sleep physiology streams. Dense streams keep the 90-day cap and previous-evening overlap. Calories are excluded from recovery. Canary `bdc6bdd1-db22-460c-bd12-701771c5f18d` completed all nine streams for September 12–14 exclusive, with sampled streams beginning September 11. Every stream has complete successful fetch coverage and retained observations. Independent provider rereads matched all 828 oxygen sample payloads, two daily oxygen payloads, and three respiratory summary payloads exactly; the nightly report loaded successfully. Only aggregate verification results were emitted.

After the canary passed, historical recovery `d48c7fcf-7ce6-4bf3-96fd-607f25530d65` ran for June 24–September 15 exclusive (through September 14). Comparisons and reporting followed in the second release.

The historical run completed eight streams, including all seven sleep pages, 12 oxygen-sample pages, and six pages each for HRV samples and respiratory summaries. Temperature alone failed with the safe category `PROVIDER_CONTRACT_INVALID` and HTTP 200. Bounded inspection found 75 records, including two with literal `"NaN"` in the optional baseline and relative-standard-deviation fields. [Google identifies both fields as optional](https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints#DailySleepTemperatureDerivations); [ProtoJSON permits a literal NaN representation](https://protobuf.dev/programming-guides/json/). The second release adds a narrow normalization fix: these two optional fields become SQL NULL, the nightly temperature remains strictly validated, and raw JSON retains the original sentinel. Temperature-only retry `e7080672-7438-42a0-b9ad-667aad3e5df4` completed after the second release and after an existing user-triggered recent sync finished. All 75 retained payloads match an independent provider reread exactly, with two unavailable baselines. The original failed chunk remains in history; current temperature availability is successful and complete.

### Verified recovery coverage — September 14, 2026

Every recovery stream has complete successful fetch coverage for June 24–September 15 exclusive; sampled streams include the preceding civil day. Counts below are retained records and distinct observation dates, not a claim of uninterrupted physiological measurement. There were no entirely empty provider streams in this recovery. Missing dates remain missing.

| Stream | Records | Observed dates | First / last observation date |
| --- | ---: | ---: | --- |
| Sleep (including naps) | 82 | 80 | June 24 / September 14 |
| Daily resting heart rate | 83 | 83 | June 24 / September 14 |
| Daily oxygen | 70 | 70 | June 25 / September 13 |
| Oxygen samples | 17,281 | 82 | June 24 / September 14 |
| Daily HRV | 75 | 75 | June 24 / September 14 |
| HRV samples | 5,403 | 75 | June 24 / September 14 |
| Daily respiratory rate | 75 | 75 | June 24 / September 14 |
| Respiratory sleep summaries | 99 | 75 | June 24 / September 14 |
| Sleep temperature | 75 | 75 | June 24 / September 14 |

Calories were excluded from the historical recovery. The existing recent sync remains independent. Retention stays at 90 days for dense fetches, and compact-write, archive-execution, pruning, read-cutover, removal, and PostgreSQL tuning gates were not enabled.

The final ingestion release passes all 330 tests (zero failures or skips, 137.8 seconds) with a disposable PostgreSQL 16 database. The observed respiratory regression adds one case and extends the real PostgreSQL test. Production build, unchanged generated workflow, and diff checks pass. The production database has enabled daily and monthly backup schedules targeting R2; no backup or retention settings were changed.

The production resource is `fitbit-health-hub-production` (`i9x2p7l752v0oxm4vp58rylt`) on Hetzner, building `main`. Automatic deployment was disabled on September 14 to enforce the approved two manual releases. Use the authenticated Coolify deployment API and verify the resulting commit and health before enqueueing recovery.

The second release `69dd384` is live; Coolify deployment `nirt4chghraqbsik214z2scf` finished and public readiness returns HTTP 200. Verification passes 337 tests, zero failures or skips (134.5 seconds), including real PostgreSQL and the optional temperature baseline regression. Production build, unchanged generated workflow, and diff checks pass. Synthetic browser checks at 375px and 1440px cover period selection, context absence, editing/deletion, clipboard denial, Markdown download, privacy defaults, and a missing selected night. New sleep export files are additive under schema 1.3.0.

Authenticated live API checks cover 7/30/90-day windows: dashboard and report period summaries/differences agree, concise reports omit check-ins by default, and every successful response is uncached. Unauthenticated calls return 401. The 30-day export dataset and Markdown match the API report exactly. Credentials and personal readings stayed on the application host; only booleans and aggregate counts were emitted. The 90-day comparison correctly reports insufficient prior history.

After temperature recovery, the affected 30-day API/report/export agreement was checked again successfully: 26 recorded main-sleep nights in the selected period and ten comparable dimensions for the September 13 wake-date selection. The final Coolify state is healthy with automatic deployment disabled. The disposable PostgreSQL container/tunnel and synthetic browser/preview were removed after verification. Both application releases are complete; subsequent documentation-only commits do not require redeployment.

## Implemented behavior

- Google v4 `oxygen-saturation` and `daily-oxygen-saturation` use `list`. Both are default sync metrics; windows are 14 and 90 days respectively. Direct and generated n8n requests use the same filters and follow pagination.
- The existing `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` permission is requested by the connector. Requested scope does not prove actual consent or intraday availability for this account.
- Sample fetches expand the requested start by one civil day, then clamp to the existing raw eligibility cutoff. Daily history is eligible from membership start. Custom raw requests beginning before the cutoff still fail. No stored data is deleted.
- Migration `008_oxygen_saturation.sql` adds retained sample and provider-daily tables. Stable provider names identify corrections. Decimal fields have no fixed scale. Original timestamps, offsets, metadata, and source JSON are preserved. Empty refetches do not erase stored records.
- Night detail selects the longest non-nap sleep session for the chosen date, with ID as tie-breaker. Physical `[start, end)` filtering includes the preceding evening. Original nanoseconds decide boundaries after the indexed PostgreSQL lookup. Without sleep, detail uses recorded sample civil dates and has no sleep-coverage denominator.
- Daily and sample metadata groups are selected independently. Multiple daily records in one group remain ambiguous. Matching timestamp/value observations collapse only for statistics; conflicts split the chart and are excluded from statistics. All provider rows remain in the reading table and raw export.
- Provider lower/upper bounds are confidence bounds, distinct from observed sample min/max. Historical provider standard deviation describes prior daily averages, not the selected night. Zero remains a value.
- Charts break at conflicts and intervals over 120 seconds. Reduction preserves first/min/max/last per chronological bucket after splitting; 1,200 points is a target, not permission to erase discontinuities. Trends weight available daily averages equally and keep missing dates blank.
- Fetch completeness requires a connected completed page chain and covering union of successful windows. Newer failed/queued attempts remain visible alongside saved measurements. Oxygen failures cannot prevent successful non-oxygen metrics from finalizing.

## User and API entry points

- Today has a SpO₂ card. `/#oxygen` has Night, 7-day, 30-day, and Year views, date/source controls, a sleep-stage lane, and a paged reading table. Recorded dates/offsets accompany sleep bounds and reading tooltips. Fetch history distinguishes attempt/completion timestamps from the newest measurement. Sleep and Journal links preserve the selected date; oxygen requests never fetch journal text.
- `GET /api/metrics/oxygen?start=YYYY-MM-DD&end=YYYY-MM-DD&resolution=day|night` requires the existing session and sends `Cache-Control: no-store`. Ranges are closed-open, at most 366 days; night detail is one selected date. Optional `sampleSource` and `dailySource` are 64-character lowercase hex metadata keys. Unknown selectors fail with 400.
- Detail over 50,000 fetched rows fails with 413 and directs the user to exports. No silent truncation. Public detail strips source JSON.
- Local synthetic preview: `npm run preview` (optional `PORT` and `FIXTURE_DATE`). It uses pg-mem and a disposable owner `preview@example.test` / `fixture-password-0000`. These are synthetic preview credentials, unrelated to production. The preview binds loopback only.

## Exports

Select `oxygen` in the existing export request or Blood oxygen in the form. Current outputs use schema `1.3.0`, preserving the oxygen files introduced in `1.1.0` and adding comparison JSON and Markdown when sleep is selected.

- `oxygen-saturation-daily.csv` retains every provider daily record, metadata, source fields, confidence bounds, and historical deviation.
- `analysis.json` contains structured daily analysis and oxygen availability. Raw rows in a full ZIP are streamed into `oxygen-saturation-samples.csv`, preserving all sources, duplicates, conflicts, original timestamp text, and source JSON.
- `daily-summary.csv` appends oxygen average, lower/upper confidence bounds, and summary state. Ambiguous provider dates have null joined values. Oxygen-only dates remain present.
- Raw export dates are **sample civil dates**, while daily export dates are **provider summary dates**. A night can begin the previous evening; the Night export action preselects two dates. The manifest explains this distinction.
- PNG summaries include an oxygen panel and column, decimal percentages, days measured, and ambiguity labels on a 1600×1000 canvas.
- `rawCoverage.oxygen` independently reports local count/date bounds and fetched-window evidence, with `coldArchiveSupported: false`. Existing R2 v1 bundles contain no oxygen. Journal remains opt-in.

## Original implementation verification — September 7, 2026

| Check | Observed result |
|---|---|
| Full project suite | `npm test`: 292 passed, 0 failed, 0 skipped, about 56 seconds, with `PG_INTEGRATION_URL` configured for an isolated test database |
| Final display refinements | 27 focused UI/layout tests passed after adding queued/running labels and dated sleep/reading context; all 4 oxygen UI tests passed again after the final text adjustment |
| PostgreSQL | PostgreSQL 17.11 in a disposable desktop container through a loopback SSH tunnel; the existing harness created and dropped isolated generated schemas |
| Production CSS build | `npm run build` passed |
| Generated n8n gateway | `npm run build:workflow` produced the same SHA-256 as the current generated JSON |
| Diff hygiene | `git diff --check` passed; the complete staged feature is checked again before committing |
| Browser | Chrome at 375px and 1440px; normal night, missing-summary trend drill-down, zero, multiple sources, completed-empty, failed sync, and mobile fetch/date details checked |
| Interaction | Keyboard point labels, escaped source labels, no page overflow, delayed-response fencing, failed-refresh view retention, and zero automatic journal requests checked |
| Export image | Synthetic 1600×1000 PNG inspected; four metric panels, decimal oxygen values, missing/ambiguous dates and table columns fit |

The PostgreSQL cases cover atomic page rollback, repeated/corrected writes, decimal precision, original nanoseconds, exact sleep boundaries, non-default session timezone, and keyset cursor ties. An existing queue regression initially exposed an approximately 0.8-second clock difference between the laptop and desktop database; its test now supplies the database clock to the repository's existing clock injection. Production scheduling behavior was unchanged.

Acceptance A1–A12 was reviewed inline against the implemented modules and focused tests: transport parity (`oxygen-sync`), storage/validation (`oxygen-normalizer`, `oxygen-ingestion`, PostgreSQL), sleep/source/statistics (`oxygen-repository`, `oxygen-statistics`), authenticated API (`api`), display (`oxygen-ui` plus browser checks), and export/retention boundaries (`oxygen-exports`, existing archive suites). No agents were dispatched.

Synthetic browser captures and logs remain under ignored `output/`; they contain no live health data. Start with this runbook and the existing implementation when continuing. Do not regenerate the spec or repeat unchanged local checks. The complete suite predates only the final display refinements covered by the focused checks above.

No real account daily/intraday response was observed during the original September 7 implementation. The current reconnection and recovery checkpoint above supersedes that original release status. Device-specific availability must be established through complete successful fetches.

## Original oxygen rollout procedure (historical)

The September 14 release and approved nine-stream recovery above supersede this original oxygen-only rollout sequence. The larger historical recovery is already authorized for this task.

1. Identify the actual FitbitTracker Coolify resource and deployed revision on Hetzner; inspect connector mode, pending jobs, database backup coverage, and restore procedure. Do not infer a resource UUID from another app or old promotion notes.
2. Obtain safe structural evidence for both Google endpoints through the existing connector. Use a recent date with sleep, include the preceding day for samples, and follow all pages. Keep credentials and personal readings out of logs and Git. Record HTTP class, field names, counts, source-group counts, and whether confidence fields exist. If the response differs, update fixtures/normalizers and run affected tests before ingestion. A valid empty response is not proof of intraday support.
3. Confirm the generated n8n fallback workflow is available before enabling oxygen jobs in that transport. Its identity and credentials are unchanged. Do not switch connector mode to bypass missing workflow support.
4. Deploy migration 008 and the reviewed code through the established manual release path. Keep compact-write, archive-execution, pruning, read-cutover, table-removal, and PostgreSQL tuning gates unchanged.
5. Queue one bounded oxygen-only canary using actual recent dates. The CLI accepts:

   ```text
   npm run sync:backfill -- <start-date> <end-date-exclusive> --metrics=oxygen-saturation,daily-oxygen-saturation
   ```

   Confirm every page completes, view/source/export values agree, and repeating the same bounded request is idempotent. Report aggregate evidence only. A 403 requires permission/provider investigation, not an empty-data label.
6. Measure sample-table bytes per imported record using PostgreSQL relation sizes, confirm backup/restore coverage, and obtain authorization for any larger backfill. Daily-only history uses `--metrics=daily-oxygen-saturation`; the default all-metric command is inappropriate for an oxygen-only backfill.

## Rollback

Pause the worker before returning to an older app image. Older workers do not understand oxygen metric chunks; inspect and pause/requeue those specific pending jobs through a reviewed operator action before restarting. Retain both additive oxygen tables and all health rows. No table drop, data restore, or archive gate change is required to roll back the code.

## Sources

The [accepted design](superpowers/specs/2026-09-07-spo2-tracker-design.md) records primary API references and field semantics. The UI links to [Google’s device guide](https://support.google.com/googlehealth/answer/14226120), which explains sleep/device processing and describes the feature as intended for general wellness.
