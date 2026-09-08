# SpO₂ implementation and release runbook

Local implementation is complete in `codex/owned-google-health-connector`, 2026-09-07. The feature commit is titled `feat: add retained SpO2 tracking with sleep context and exports`. Production release and account-specific data availability are pending. This document does not authorize deployment, production backfill, connector-mode changes, or archive gates.

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

Select `oxygen` in the existing export request or Blood oxygen in the form. New outputs use schema `1.1.0`.

- `oxygen-saturation-daily.csv` retains every provider daily record, metadata, source fields, confidence bounds, and historical deviation.
- `analysis.json` contains structured daily analysis and oxygen availability. Raw rows in a full ZIP are streamed into `oxygen-saturation-samples.csv`, preserving all sources, duplicates, conflicts, original timestamp text, and source JSON.
- `daily-summary.csv` appends oxygen average, lower/upper confidence bounds, and summary state. Ambiguous provider dates have null joined values. Oxygen-only dates remain present.
- Raw export dates are **sample civil dates**, while daily export dates are **provider summary dates**. A night can begin the previous evening; the Night export action preselects two dates. The manifest explains this distinction.
- PNG summaries include an oxygen panel and column, decimal percentages, days measured, and ambiguity labels on a 1600×1000 canvas.
- `rawCoverage.oxygen` independently reports local count/date bounds and fetched-window evidence, with `coldArchiveSupported: false`. Existing R2 v1 bundles contain no oxygen. Journal remains opt-in.

## Verification and handoff

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

No real account daily/intraday response has been observed during this implementation. Device support, granted consent, live record cadence, and backup coverage of the new tables must be established during release preparation.

## Release sequence after authorization

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
