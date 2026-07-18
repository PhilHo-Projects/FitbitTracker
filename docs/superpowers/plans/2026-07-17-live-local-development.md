# Live Local Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `npm run dev` start the Personal Health Data Hub locally with password `0000`, an isolated local PostgreSQL database, and manual synchronization through a separate live Hetzner n8n gateway, while preserving the existing scheduled sleep workflow.

**Architecture:** The local app and database stay on the laptop; Google OAuth and Google Health API access stay in Hetzner n8n. A new webhook-only `healthHubGateway001` workflow handles the hub's read-only operation/metric contract. Local live and fixture modes use different named Docker volumes, and local live mode runs the persistent sync worker without its three-hour enqueue timer.

**Tech Stack:** Node.js 22 ESM, Express 4, PostgreSQL 16, Docker Compose, Node test runner, n8n 2.30.4, Google Health API v4, PowerShell 7, Git.

## Global Constraints

- Preserve the active legacy workflow `fitbitTracker001` at `/webhook/fitness-sync`; do not edit, deactivate, or replace it during this work.
- Create the hub workflow as `healthHubGateway001` at `/webhook/health-hub-sync`, with no Schedule Trigger or cron.
- Keep all Google operations read-only and allow-listed.
- Never print, commit, or place `COOLIFY_TOKEN`, `N8N_WEBHOOK_TOKEN`, OAuth tokens, decrypted n8n credentials, journal keys, or session secrets in logs or tracked files.
- Use `.env.local` only for real local credentials; keep it ignored by Git and Docker.
- Use separate Docker volumes named `health-hub-postgres-live` and `health-hub-postgres-fixtures`. Never reuse one mode's volume for the other.
- Local sync is manual through the UI/API. The queue worker must continue processing manually queued jobs, but `SYNC_SCHEDULE_ENABLED=false` must prevent timer-created jobs.
- Production scheduling remains enabled by default when `SYNC_SCHEDULE_ENABLED` is absent.
- Preserve unrelated dirty work and the dirty tracked file in the primary worktree. Do not reset, discard, or silently overwrite it.
- Do not push or deploy the app to Coolify unless the user asks. This plan changes only local app behavior and adds the separate n8n workflow.
- Keep AWS untouched.

---

### Task 1: Verify and checkpoint the existing Personal Health Data Hub baseline

**Files:**

- Review all currently modified/untracked files reported by `git status --short`
- Verify: `test/*.test.js`
- Verify: `Dockerfile`
- Verify: `n8n/fitness-workflow.json`
- Verify: `scripts/build-n8n-workflow.mjs`

The hub implementation predates this local-live change but is still uncommitted. Establish a tested checkpoint first so later commits contain only the behavior requested here.

- [ ] Confirm the worktree and branch before changing anything:

```powershell
git rev-parse --show-toplevel
git branch --show-current
git status --short
```

Expected root: `D:/WebDev/FitbitTracker/.worktrees/personal-health-data-hub`. Expected branch: `codex/personal-health-data-hub`.

- [ ] Run the existing test suite and record any failures without editing code:

```powershell
npm test
```

Expected: all existing tests pass. If a test fails, use `superpowers:systematic-debugging` and fix only the demonstrated baseline defect before proceeding.

- [ ] Run all baseline build checks:

```powershell
npm run build
npm run build:workflow
docker build -t personal-health-data-hub:baseline .
```

Expected: all commands exit `0`.

- [ ] Review the baseline diff and scan for secrets:

```powershell
git diff --check
git diff --stat
git status --short
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' "(COOLIFY_TOKEN|N8N_WEBHOOK_TOKEN=.+|refresh_token|access_token|client_secret)" .
```

Expected: no real secret values. Placeholder/example values are acceptable only in tracked example files.

- [ ] Commit the existing hub baseline intentionally, including the new database, job, route, export, UI, and test files, but excluding `.env.local`, `.env.live`, generated `public/styles.css`, runtime files, and screenshots:

```powershell
git add .dockerignore .env.example .gitignore Dockerfile README.md db docker-compose.dev.yml lib package.json package-lock.json public scripts server.js src test n8n/fitness-workflow.json
git restore --staged n8n/fitness-workflow.json scripts/build-n8n-workflow.mjs test/workflow.test.js
git diff --cached --check
git diff --cached --stat
git commit -m "feat: build personal health data hub"
```

Expected: the app baseline is checkpointed. The three workflow-specific files remain deliberately dirty for Task 4, `.env.live.example` remains untracked until Task 2 replaces it, and ignored runtime files remain outside Git.

---

### Task 2: Make live Google Health data the default local mode

**Files:**

- Create: `scripts/dev-config.mjs`
- Modify: `test/local-development.test.js`
- Modify: `scripts/dev.mjs`
- Modify: `docker-compose.dev.yml`
- Modify: `package.json`
- Create: `.env.local.example`
- Delete: `.env.live.example`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] Replace the current source-text test with behavior tests for a pure configuration resolver. Add tests equivalent to:

```js
import { createDevelopmentConfig } from '../scripts/dev-config.mjs';

test('default development mode requires live gateway credentials and uses the live volume', () => {
  const config = createDevelopmentConfig({
    mode: 'live',
    sourceEnv: {
      N8N_WEBHOOK_URL: 'https://n8n.philippeho.dev/webhook/health-hub-sync',
      N8N_WEBHOOK_TOKEN: 'test-token',
    },
  });

  assert.equal(config.seedFixtures, false);
  assert.equal(config.composeProjectName, 'health-hub-live');
  assert.equal(config.postgresVolume, 'health-hub-postgres-live');
  assert.equal(config.env.DASHBOARD_PASSWORD, '0000');
  assert.equal(config.env.SYNC_SCHEDULE_ENABLED, 'false');
});

test('fixture mode has no n8n dependency and uses a different volume', () => {
  const config = createDevelopmentConfig({ mode: 'fixtures', sourceEnv: {} });

  assert.equal(config.seedFixtures, true);
  assert.equal(config.composeProjectName, 'health-hub-fixtures');
  assert.equal(config.postgresVolume, 'health-hub-postgres-fixtures');
  assert.equal(config.env.N8N_WEBHOOK_URL, undefined);
  assert.equal(config.env.N8N_WEBHOOK_TOKEN, undefined);
});

test('live mode rejects missing, placeholder, or legacy gateway configuration', () => {
  assert.throws(
    () => createDevelopmentConfig({ mode: 'live', sourceEnv: {} }),
    /Create .env.local/,
  );
  assert.throws(
    () => createDevelopmentConfig({
      mode: 'live',
      sourceEnv: {
        N8N_WEBHOOK_URL: 'https://n8n.philippeho.dev/webhook/fitness-sync',
        N8N_WEBHOOK_TOKEN: 'replace-me',
      },
    }),
    /health-hub-sync/,
  );
});
```

- [ ] Run the focused tests and verify RED:

```powershell
node --test test/local-development.test.js
```

Expected failure: `ERR_MODULE_NOT_FOUND` for `scripts/dev-config.mjs`.

- [ ] Implement `createDevelopmentConfig({ mode, sourceEnv })` as a side-effect-free exported function. It must:

  - accept only `live` and `fixtures`;
  - set `NODE_ENV=development`, `PORT=3000`, local `DATABASE_URL`, and `DASHBOARD_PASSWORD=0000`;
  - generate deterministic non-production session/journal defaults when missing;
  - set `SYNC_SCHEDULE_ENABLED=false` in live mode;
  - require the exact URL origin/path ending `/webhook/health-hub-sync` and a non-placeholder token in live mode;
  - remove n8n variables from fixture mode;
  - return `seedFixtures`, `composeProjectName`, `postgresVolume`, and the child-process `env` object.

The validation interface must be:

```js
export function createDevelopmentConfig({ mode = 'live', sourceEnv = {} } = {}) {
  // Return { mode, env, seedFixtures, composeProjectName, postgresVolume }.
}
```

- [ ] Refactor `scripts/dev.mjs` to load `.env.local` for live mode, select fixture mode only with `--fixtures`, and pass Compose isolation explicitly:

```js
const mode = process.argv.includes('--fixtures') ? 'fixtures' : 'live';
if (mode === 'live') {
  const result = dotenv.config({ path: '.env.local' });
  if (result.error) throw new Error('Create .env.local from .env.local.example before running npm run dev');
}
const config = createDevelopmentConfig({ mode, sourceEnv: process.env });
```

Start PostgreSQL with both the project name and volume environment set:

```js
spawnSync('docker', [
  'compose', '-p', config.composeProjectName,
  '-f', 'docker-compose.dev.yml', 'up', '-d', 'postgres',
], { env: config.env, stdio: 'inherit', shell: process.platform === 'win32' });
```

Run migrations in both modes, seed only when `config.seedFixtures` is true, build Tailwind, and then spawn `server.js` with `config.env`.

- [ ] Parameterize `docker-compose.dev.yml` without a shared fixed volume:

```yaml
services:
  postgres:
    volumes:
      - health-hub-postgres:/var/lib/postgresql/data

volumes:
  health-hub-postgres:
    name: ${HEALTH_HUB_POSTGRES_VOLUME:?HEALTH_HUB_POSTGRES_VOLUME is required}
```

`createDevelopmentConfig` must set `HEALTH_HUB_POSTGRES_VOLUME` to the mode-specific name.

- [ ] Update scripts in `package.json`:

```json
"dev": "node scripts/dev.mjs",
"dev:live": "npm run dev",
"dev:fixtures": "node scripts/dev.mjs --fixtures"
```

- [ ] Replace `.env.live.example` with `.env.local.example`. It must include the new gateway URL, placeholders for secrets, `DASHBOARD_PASSWORD=0000`, `SYNC_SCHEDULE_ENABLED=false`, and `SKIP_LOCAL_DATABASE=false`. It must not contain a real token.

- [ ] Update `.env.example` and `README.md` so documentation states:

  - `npm run dev` is real-data/manual-sync mode using `.env.local`;
  - `npm run dev:fixtures` is deterministic offline mode;
  - both use password `0000`;
  - the two modes use separate PostgreSQL volumes;
  - local mode does not install or run n8n;
  - local mode never schedules automatic syncs;
  - `npm run dev:live` remains an alias;
  - the gateway URL is `/webhook/health-hub-sync`.

- [ ] Run focused tests and verify GREEN:

```powershell
node --test test/local-development.test.js
```

Expected: all local-development tests pass.

- [ ] Commit:

```powershell
git add scripts/dev-config.mjs scripts/dev.mjs docker-compose.dev.yml package.json package-lock.json test/local-development.test.js .env.local.example .env.live.example .env.example README.md
git diff --cached --check
git commit -m "fix: make live data the default local mode"
```

---

### Task 3: Keep manual queue processing but disable local timer-created syncs

**Files:**

- Modify: `test/sync.test.js`
- Modify: `lib/jobs/sync-service.js`
- Modify: `server.js`

- [ ] Add an injected timer interface and a behavioral test. The test must prove that `start({ scheduleEnabled: false })` schedules the immediate queue poll but never creates an interval:

```js
test('manual-only worker polls queued jobs without creating a scheduled sync interval', async () => {
  const timeouts = [];
  const intervals = [];
  const service = createSyncService({
    pool: {},
    repository: {
      recoverStaleClaims: async () => {},
      claimNextChunk: async () => null,
    },
    gateway: {},
    writer: {},
    timers: {
      setTimeout: (callback, delay) => (timeouts.push({ callback, delay }), timeouts.length),
      clearTimeout: () => {},
      setInterval: (callback, delay) => (intervals.push({ callback, delay }), intervals.length),
      clearInterval: () => {},
    },
  });

  service.start({ scheduleEnabled: false });
  await new Promise(setImmediate);

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, 0);
  assert.equal(intervals.length, 0);
  service.stop();
});
```

- [ ] Run the focused test and verify RED:

```powershell
node --test --test-name-pattern="manual-only worker" test/sync.test.js
```

Expected failure: an interval is still created, or the injected timer interface is not used.

- [ ] Add `timers` to `createSyncService` with defaults bound to the platform functions:

```js
timers = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
},
```

Change the start signature to:

```js
start({
  pollIntervalMs = 1000,
  syncIntervalMs = 3 * 60 * 60 * 1000,
  scheduleEnabled = true,
} = {})
```

Use the injected timers for every timeout/interval. Create `scheduleTimer` only when `scheduleEnabled` is true. `stop()` must safely clear whichever timers exist.

- [ ] Pass the environment policy from the direct-run server:

```js
syncService?.start({
  scheduleEnabled: process.env.SYNC_SCHEDULE_ENABLED !== 'false',
});
```

This preserves production's current default and disables only explicitly configured local runs.

- [ ] Run focused and related tests:

```powershell
node --test test/sync.test.js test/server.test.js test/api.test.js
```

Expected: all pass.

- [ ] Commit:

```powershell
git add test/sync.test.js lib/jobs/sync-service.js server.js
git diff --cached --check
git commit -m "fix: support manual-only local synchronization"
```

---

### Task 4: Generate a separate webhook-only n8n workflow for the hub

**Files:**

- Modify: `test/workflow.test.js`
- Modify: `scripts/build-n8n-workflow.mjs`
- Create: `n8n/health-hub-workflow.json`
- Restore: `n8n/fitness-workflow.json`
- Modify: `README.md`

- [ ] Point workflow tests at `n8n/health-hub-workflow.json` and require the isolated identity:

```js
assert.equal(workflow.id, 'healthHubGateway001');
assert.equal(workflow.name, 'Personal Health Data Hub — Google Health gateway');
assert.equal(webhook.parameters.path, 'health-hub-sync');
assert.equal(webhook.webhookId, 'health-hub-sync-webhook');
assert.equal(workflow.active, true);
assert.equal(workflow.nodes.some(({ type }) => type === 'n8n-nodes-base.scheduleTrigger'), false);
```

Retain the existing tests for Header Auth credential ID/name, Google credential ID/name, operation/metric allow-lists, request construction, and stable response shape.

- [ ] Add a regression test that parses `n8n/fitness-workflow.json` separately and asserts the legacy workflow still has ID `fitbitTracker001` and webhook path `fitness-sync`.

- [ ] Run the workflow tests and verify RED:

```powershell
node --test test/workflow.test.js
```

Expected failure: `n8n/health-hub-workflow.json` does not exist.

- [ ] Modify the workflow generator constants and output path:

```js
const workflowPath = new URL('../n8n/health-hub-workflow.json', import.meta.url);

workflow.id = 'healthHubGateway001';
workflow.name = 'Personal Health Data Hub — Google Health gateway';
```

The Webhook node must use path `health-hub-sync`, webhook ID `health-hub-sync-webhook`, and the existing Header Auth credential:

```js
httpHeaderAuth: {
  id: 'fitbitTrackerWebhookAuth',
  name: 'FitbitTracker Webhook Auth',
}
```

The HTTP Request node must continue using:

```js
googleOAuth2Api: {
  id: 'zTvzoPpvTXOvI3rA',
  name: 'Google account',
}
```

Do not add a Schedule Trigger. Keep only Webhook → Validate and Prepare → Google Health API → Shape Response → Respond.

- [ ] Restore `n8n/fitness-workflow.json` to its committed legacy artifact from `origin/main` using an `apply_patch` edit, not a destructive checkout. Confirm its ID/path remain `fitbitTracker001`/`fitness-sync`.

- [ ] Generate and test the new artifact:

```powershell
npm run build:workflow
node --test test/workflow.test.js
git diff --exit-code -- n8n/health-hub-workflow.json
```

Expected: tests pass and regeneration leaves the generated artifact unchanged.

- [ ] Update README workflow documentation and project layout to list both artifacts and identify the legacy file as preserved.

- [ ] Commit:

```powershell
git add test/workflow.test.js scripts/build-n8n-workflow.mjs n8n/health-hub-workflow.json n8n/fitness-workflow.json README.md
git diff --cached --check
git commit -m "feat: add isolated Google Health gateway workflow"
```

---

### Task 5: Materialize secure local live configuration

**Files:**

- Create ignored file: `.env.local`
- Verify: `.gitignore`
- Verify: `.dockerignore`

- [ ] Verify ignore rules before retrieving any token:

```powershell
git check-ignore -v .env.local
git check-ignore -v .env.local.example
```

Expected: `.env.local` is ignored; `.env.local.example` is not ignored.

- [ ] Obtain the existing shared Header Auth token from the current Fitbit Coolify app container on Hetzner without printing it. Find the current app container using label/name fragment `cdwyptq886dh4j2om0dz88us`, read only `N8N_WEBHOOK_TOKEN` internally, and write `.env.local` through `apply_patch` orchestration. Do not return the value in tool output.

- [ ] Write `.env.local` with fixed values `NODE_ENV=development`, `PORT=3000`, `DATABASE_URL=postgres://health_hub:health_hub_dev@127.0.0.1:54329/health_hub`, `DASHBOARD_PASSWORD=0000`, `N8N_WEBHOOK_URL=https://n8n.philippeho.dev/webhook/health-hub-sync`, `SYNC_SCHEDULE_ENABLED=false`, and `SKIP_LOCAL_DATABASE=false`. Generate a fresh random local session secret of at least 32 bytes, a fresh base64-encoded 32-byte AES journal key prefixed with `1:`, and insert the retrieved non-placeholder Header Auth token.

- [ ] Confirm safely, printing names and classifications only:

```powershell
git status --short --ignored .env.local
```

Use a local parser to assert required keys are present, the URL path is exact, the password is `0000`, the token is non-placeholder, and the secrets have adequate lengths. The parser must output only pass/fail booleans, never values.

Expected: `.env.local` appears only as ignored and all assertions pass.

---

### Task 6: Deploy the second workflow to Hetzner n8n without disturbing sleep sync

**Remote target:** `root@95.217.6.255`

**n8n container:** discover by image/name; current known name is `n8n-yq5xavsql2d3sxzhmz8zg2om`

- [ ] Before mutations, inspect current n8n container identity, version, workflow list, and active state. Confirm `fitbitTracker001` is active and `healthHubGateway001` does not yet exist.

- [ ] Create timestamped server-side backups under a root-only directory. Export the legacy workflow and encrypted credential records only. If a command creates plaintext containing secrets, encrypt it immediately with a generated backup key held outside the backup directory, securely remove the plaintext, and verify the encrypted file exists. Never use `--decrypted` for credential export.

- [ ] Confirm the existing Google OAuth credential's configured scope list without exposing tokens. Required superset:

```text
https://www.googleapis.com/auth/googlehealth.sleep.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
```

- [ ] If any scope is absent, update only the scope field in n8n and reconnect the `Google account` credential once through Google consent. This is the only expected interactive checkpoint. Do not continue heart/calorie/profile smoke tests until consent succeeds and a safe scope-only audit confirms all four scopes.

- [ ] Copy `n8n/health-hub-workflow.json` into the n8n container and import it with the JSON active state:

```bash
n8n import:workflow --input=/tmp/health-hub-workflow.json --activeState=fromJson
n8n publish:workflow --id=healthHubGateway001
```

Run the commands as the same container user and with the same n8n environment/data directory used by the running service.

- [ ] Restart only the n8n container if needed to register the production webhook. Do not restart app containers, Docker, Coolify, or AWS.

- [ ] Verify after deployment:

  - `fitbitTracker001` remains active at `fitness-sync`;
  - `healthHubGateway001` is active at `health-hub-sync`;
  - the new workflow contains no Schedule Trigger;
  - both workflows reference the intended Header Auth and Google OAuth credentials;
  - an unauthenticated new-webhook request is rejected;
  - authenticated `identity`, `profile`, and a one-day bounded metric request return the stable gateway contract.

Only print HTTP status, `ok`, operation/metric, and record counts. Do not print health records, identity data, tokens, or OAuth material.

---

### Task 7: Verify local live and fixture behavior end to end

**Files:**

- Verify: `.env.local`
- Verify: local PostgreSQL live/fixture volumes
- Verify: app APIs through `http://127.0.0.1:3000`

- [ ] Ensure port 3000 is free. If occupied, identify the owning PID and stop only the stale process belonging to this project. Do not kill unrelated processes.

- [ ] Start the exact user command from the hub worktree:

```powershell
npm run dev
```

Expected startup log: live mode, local PostgreSQL, `http://localhost:3000`, password `0000`, and manual-only scheduling.

- [ ] Verify login and a manual recent sync using an HTTP client with a cookie jar:

  1. `POST /login` with password `0000`;
  2. `POST /api/sync` with `{ "mode": "recent" }`;
  3. poll `GET /api/sync/status` until completed or a bounded timeout;
  4. query dashboard/metric endpoints and report only status/counts.

Expected: the job is requested by the manual/API path, the queue worker processes it, and data is stored in the live local database.

- [ ] Wait longer than one short test scheduling interval only in an injected/unit test; do not wait three hours. Query `sync_jobs` and prove no job has `requested_by='schedule'` in the local live database.

- [ ] Stop the app cleanly and start fixture mode:

```powershell
npm run dev:fixtures
```

Expected: no `.env.local` or n8n dependency, password `0000`, and seeded deterministic data.

- [ ] Inspect Docker volumes and database counts to prove the live and fixture databases are distinct. Do not delete either volume.

- [ ] Stop fixture mode cleanly and run full verification:

```powershell
npm test
npm run build
npm run build:workflow
git diff --exit-code -- n8n/health-hub-workflow.json
docker build -t personal-health-data-hub:verified .
git diff --check
git status --short
```

Expected: all commands pass; only ignored `.env.local` and expected runtime state remain outside Git.

---

### Task 8: Promote the tested hub branch to the primary workspace

**Primary workspace:** `D:\WebDev\FitbitTracker`

**Source branch:** `codex/personal-health-data-hub`

- [ ] In the primary workspace, inspect status and preserve the user's dirty tracked `n8n/fitness-workflow.json` edit in a named stash containing that path only:

```powershell
git status --short
git stash push -m "pre-health-hub root workflow edit" -- n8n/fitness-workflow.json
git stash list
```

Do not include the untracked `.superpowers/` directory and do not drop the stash.

- [ ] Fetch without changing files, verify ancestry, then fast-forward `main` to the tested hub branch only if Git confirms it is a fast-forward:

```powershell
git fetch origin
git merge-base --is-ancestor main codex/personal-health-data-hub
git merge --ff-only codex/personal-health-data-hub
```

If fast-forward is impossible or any unexpected tracked change remains, stop and report the exact blocker instead of merging forcefully.

- [ ] Materialize the same ignored `.env.local` in the primary workspace through secret-safe orchestration. Do not copy it with a command that prints contents.

- [ ] Install/verify dependencies and test the user's exact command from `D:\WebDev\FitbitTracker`:

```powershell
npm ci
npm test
npm run dev
```

Expected: the Personal Health Data Hub starts on port 3000, accepts password `0000`, and performs manual real-data sync through `/webhook/health-hub-sync` without local n8n.

- [ ] Report the preserved stash name, active branch/commit, live and fixture volume names, local URL/password, and n8n workflow IDs/paths. Do not apply or drop the stash, push the branch, deploy the app, or alter AWS.

---

## Final Verification Checklist

- [ ] `npm run dev` from `D:\WebDev\FitbitTracker` starts the newer Personal Health Data Hub.
- [ ] Login password is `0000`.
- [ ] No local n8n installation or process is required.
- [ ] Manual sync reaches `healthHubGateway001` at `/webhook/health-hub-sync`.
- [ ] Local live mode creates no timer-scheduled jobs.
- [ ] Fixture mode remains available as `npm run dev:fixtures`.
- [ ] Live and fixture PostgreSQL volumes are different.
- [ ] Legacy `fitbitTracker001` remains active and unchanged at `/webhook/fitness-sync`.
- [ ] New n8n workflow has no Schedule Trigger.
- [ ] Tests, builds, generated-workflow check, Docker build, login, and bounded manual sync all pass.
- [ ] No secrets are tracked or printed.
- [ ] The primary worktree's previous dirty workflow edit remains preserved in a named stash.
- [ ] No app deployment, Git push, AWS mutation, or destructive cleanup occurred.
