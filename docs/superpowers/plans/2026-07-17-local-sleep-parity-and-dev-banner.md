# Local Sleep Parity and Development Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist real Google Health sleep records on localhost, distinguish localhost visually, and document the one-time Hetzner promotion gap before any push.

**Architecture:** Keep separate PostgreSQL data stores while sharing the authenticated health-hub n8n gateway. Correct the PostgreSQL-date conversion at the sleep ingestion boundary, expose local-host detection as a pure browser helper, and leave production unchanged until its persistent PostgreSQL resource is configured.

**Tech Stack:** Node.js 20, Express, PostgreSQL 16, browser ES modules, Tailwind source CSS, Node test runner, Docker, Coolify.

## Global Constraints

- Do not copy production health rows or a production database dump locally.
- Do not deploy the application, mutate production health data, or change the legacy sleep workflow.
- Do not use subagents.
- Do not print health values or secrets during diagnostics; dates, shapes, statuses, and row counts are sufficient.
- Keep tests and synchronization bounded until focused verification passes.

---

### Task 1: Preserve sleep records when PostgreSQL returns date objects

**Files:**
- Modify: `test/sync.test.js`
- Modify: `lib/jobs/sync-service.js`

**Interfaces:**
- Consumes: `createSyncService(...)`, PostgreSQL `date` values returned as JavaScript `Date` objects, and the existing `dateOnly(value)` helper.
- Produces: sleep normalization receives `YYYY-MM-DD` boundaries and persists matching `sleep_sessions` rows.

- [ ] **Step 1: Add a failing worker regression test**

Add a test that enqueues a one-day sleep job, returns one valid Google Health sleep point, runs the worker, and asserts that the session is stored:

```js
test('sync worker converts PostgreSQL date objects before filtering sleep records', async () => {
  const pool = await createDatabase();
  const repository = createSyncRepository(pool, { advisoryLocks: false });
  const service = createSyncService({
    pool,
    repository,
    writer: createMetricWriter(pool),
    gateway: {
      request: async () => ({
        ok: true,
        metric: 'sleep',
        status: 200,
        data: {
          dataPoints: [{
            dataPointName: 'worker-sleep',
            sleep: {
              interval: {
                startTime: '2026-07-17T03:00:00Z',
                endTime: '2026-07-17T11:00:00Z',
                startUtcOffset: '-14400s',
                endUtcOffset: '-14400s',
                civilEndTime: { date: { year: 2026, month: 7, day: 17 }, time: { hours: 7 } },
              },
              type: 'STAGES',
              metadata: { nap: false, processed: true, stagesStatus: 'SUCCEEDED' },
              summary: {
                minutesInSleepPeriod: '480',
                minutesAsleep: '450',
                minutesAwake: '30',
                stagesSummary: [],
              },
              stages: [],
            },
          }],
        },
        nextPageToken: null,
      }),
    },
  });

  await service.enqueue({
    mode: 'custom',
    startDate: '2026-07-17',
    endDateExclusive: '2026-07-18',
    metrics: ['sleep'],
    requestedBy: 'test',
  });
  await service.runOnce();

  const sessions = await pool.query('SELECT provider_key, civil_date FROM sleep_sessions');
  assert.equal(sessions.rowCount, 1);
  assert.equal(sessions.rows[0].provider_key, 'worker-sleep');
  assert.equal(new Date(sessions.rows[0].civil_date).toISOString().slice(0, 10), '2026-07-17');
  await pool.end();
});
```

- [ ] **Step 2: Run the regression test and verify the existing bug**

Run:

```powershell
node --test --test-name-pattern="converts PostgreSQL date objects" test/sync.test.js
```

Expected: FAIL because `sleep_sessions` has zero rows. `String(chunk.start_date).slice(0, 10)` produces a weekday string such as `Thu Jul 16`, causing the normalizer's closed-open date filter to reject the record.

- [ ] **Step 3: Use the shared date conversion helper at the ingestion boundary**

Change the sleep branch in `lib/jobs/sync-service.js` to:

```js
const normalized = normalizeSleepResponse({
  dataPoints: data.dataPoints ?? [],
  startDate: dateOnly(chunk.start_date),
  endDateExclusive: dateOnly(chunk.end_date_exclusive),
});
```

- [ ] **Step 4: Run the focused sync and normalizer tests**

Run:

```powershell
node --test test/sync.test.js test/sleep-normalizer.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit the sleep fix**

```powershell
git add test/sync.test.js lib/jobs/sync-service.js
git commit -m "fix: persist bounded sleep sync records"
```

---

### Task 2: Add a localhost-only development banner

**Files:**
- Modify: `public/health-ui.js`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Modify: `src/input.css`
- Modify: `test/health-ui.test.js`
- Modify: `test/sleep-layout.test.js`
- Generated by build: `public/styles.css`

**Interfaces:**
- Produces: `isLocalDevelopmentHost(hostname): boolean` for browser initialization and unit tests.
- Consumes: `window.location.hostname` and the existing app header layout.

- [ ] **Step 1: Add failing hostname and markup contract tests**

Import `isLocalDevelopmentHost` in `test/health-ui.test.js` and add:

```js
test('development indicator recognizes only loopback browser hosts', () => {
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]']) {
    assert.equal(isLocalDevelopmentHost(hostname), true);
  }
  assert.equal(isLocalDevelopmentHost('fitbit.philippeho.dev'), false);
});
```

Extend `test/sleep-layout.test.js` with assertions that `public/index.html` contains `id="environmentBanner"`, the exact label `LOCAL DEVELOPMENT`, and `hidden`, while `public/app.js` calls `isLocalDevelopmentHost(window.location.hostname)`.

- [ ] **Step 2: Run the focused tests and verify the feature is absent**

Run:

```powershell
node --test test/health-ui.test.js test/sleep-layout.test.js
```

Expected: FAIL because the helper and banner do not exist.

- [ ] **Step 3: Implement the pure hostname check**

Add to `public/health-ui.js`:

```js
export function isLocalDevelopmentHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname || '').toLowerCase());
}
```

Import it in `public/app.js` and initialize the banner once:

```js
const localDevelopment = isLocalDevelopmentHost(window.location.hostname);
$('#environmentBanner').hidden = !localDevelopment;
document.body.classList.toggle('is-local-development', localDevelopment);
```

- [ ] **Step 4: Add the banner markup and responsive styling**

Insert before `.app-header` in `public/index.html`:

```html
<div id="environmentBanner" class="environment-banner" role="status" hidden>
  LOCAL DEVELOPMENT
</div>
```

Add to `src/input.css`:

```css
.environment-banner {
  position: sticky;
  top: 0;
  z-index: calc(var(--z-sticky) + 1);
  min-height: 26px;
  display: grid;
  place-items: center;
  padding: 4px 12px;
  color: #211305;
  background: var(--awake);
  font-size: 0.66rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.app-body.is-local-development .app-header { top: 26px; }
```

- [ ] **Step 5: Build CSS and run focused UI tests**

Run:

```powershell
npm run build
node --test test/health-ui.test.js test/sleep-layout.test.js
```

Expected: build succeeds and all focused tests pass.

- [ ] **Step 6: Commit the banner**

```powershell
git add public/health-ui.js public/app.js public/index.html src/input.css public/styles.css test/health-ui.test.js test/sleep-layout.test.js
git commit -m "feat: identify the localhost environment"
```

---

### Task 3: Document the actual Hetzner promotion boundary

**Files:**
- Create: `docs/hetzner-promotion.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: deployed commit `ec2be2faeb028c59e25c7c76c1f05dd475911d13`, Coolify application `fitbit-trackergitmain-samwhslbfx2h59wnzlcqkamm`, and `.env.example`.
- Produces: a one-time production prerequisite checklist plus the normal future branch-to-Coolify update loop.

- [ ] **Step 1: Write the deployment boundary explicitly**

Document these verified facts:

- Hetzner currently runs the legacy sleep dashboard from `main` at commit `ec2be2f`.
- That image has no `db/migrations/001_initial.sql`, no `DATABASE_URL`, and no persistent app mount.
- The local health-hub branch is therefore a product upgrade, not a byte-for-byte development copy.
- Before deploying it, create persistent PostgreSQL 16 storage in Coolify and configure `DATABASE_URL`, `DATABASE_SSL`, `JOURNAL_ENCRYPTION_KEYS`, the existing dashboard secrets, and the existing health-hub n8n settings.
- Keep the current container available until migrations, `/readyz`, login, bounded sync, and dashboard checks pass.
- After the one-time database setup, normal updates are local branch → tests → push/PR → merge to `main` → Coolify automatic deployment.

- [ ] **Step 2: Link the promotion guide from Local development**

Add a short `README.md` link stating that local and production use the same schema but separate persistent PostgreSQL data stores, and that the guide lists the one-time Coolify database setup required before the first health-hub deployment.

- [ ] **Step 3: Check documentation for placeholders and secrets**

Run:

```powershell
rg -n "TBD|TODO|PLACEHOLDER|N8N_WEBHOOK_TOKEN=.*[^e]" docs/hetzner-promotion.md README.md
git diff --check
```

Expected: no placeholders, embedded tokens, or whitespace errors.

- [ ] **Step 4: Commit the promotion guide**

```powershell
git add docs/hetzner-promotion.md README.md
git commit -m "docs: define Hetzner health hub promotion"
```

---

### Task 4: Run bounded real-data and release verification

**Files:**
- No production-code changes expected.

**Interfaces:**
- Consumes: localhost at `http://127.0.0.1:3000`, local `health-hub-live-postgres-1`, and the authenticated health-hub n8n gateway.
- Produces: evidence that the selected sleep date persists and renders, plus a precise list of remaining pre-push production infrastructure work.

- [ ] **Step 1: Restart localhost with the fixed branch**

Run `npm run dev`, wait conditionally for `GET /readyz` to return 200, and do not delete the `health-hub-postgres-live` volume.

- [ ] **Step 2: Submit one bounded sleep-only job**

Authenticate with local password `0000`, then submit:

```json
{
  "mode": "custom",
  "startDate": "2026-07-17",
  "endDateExclusive": "2026-07-18",
  "metrics": ["sleep"]
}
```

Poll by condition until the job is terminal. Expected: `completed`, one sleep chunk completed, zero failed chunks.

- [ ] **Step 3: Verify persistence and UI contracts without printing health values**

Check that local `sleep_sessions` and `sleep_stages` counts are non-zero, `GET /api/dashboard?date=2026-07-17` returns a non-null sleep section, and `GET /api/metrics/sleep?start=2026-07-17&end=2026-07-18` returns at least one record. Open localhost and confirm the orange banner is visible; request the production HTML and confirm it does not contain the new banner because production has not been deployed.

- [ ] **Step 4: Run final automated verification once**

Run:

```powershell
npm test
npm run build
npm run build:workflow
git diff --check
git status --short
```

Expected: all tests pass, builds succeed, no whitespace errors, and the worktree is clean after commits.

- [ ] **Step 5: Report alignment honestly**

Report the local sleep result, banner result, local branch commit, deployed Hetzner commit, and the one-time PostgreSQL/Coolify prerequisite. Do not recommend pushing until the production database resource and required environment variables are ready.
