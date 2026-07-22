import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production container applies migrations before starting and includes migration assets', async () => {
  const [packageJson, dockerfile, dockerignore, server] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../.dockerignore', import.meta.url), 'utf8'),
    readFile(new URL('../server.js', import.meta.url), 'utf8'),
  ]);

  assert.equal(packageJson.scripts.start, 'node scripts/start.mjs');
  assert.equal(packageJson.scripts['health:compact'], 'node scripts/compact-health.mjs');
  assert.equal(packageJson.scripts['health:archive'], 'node scripts/health-archive.mjs');
  assert.match(dockerfile, /COPY --from=build \/app\/db \.\/db/);
  assert.match(dockerfile, /COPY --from=build \/app\/scripts \.\/scripts/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends curl/);
  assert.match(dockerfile, /HEALTHCHECK .*\/readyz/);
  assert.match(dockerignore, /^\.runtime$/m);
  assert.match(dockerignore, /^output$/m);
  assert.match(server, /SYNC_INTERVAL_HOURS/);
  assert.match(server, /SYNC_SCHEDULE_LOOKBACK_DAYS/);
  assert.match(server, /HEALTH_COMPACT_WRITES_ENABLED === 'true'/);
  assert.match(server, /RAW_RETENTION_DAYS/);
  assert.doesNotMatch(server, /rawPruningEnabled:/);
  assert.match(server, /archiveConfig\.enabled/);
  assert.match(server, /archiveWorker\?\.start\(\)/);
  assert.match(server, /archiveWorker\?\.stop\(\)/);
  assert.doesNotMatch(server, /HEALTH_ARCHIVE_PRUNING_ENABLED/);
});

test('lifelong archive runbook preserves bucket, backup, restore, and approval controls', async () => {
  const [runbook, environment] = await Promise.all([
    readFile(new URL('../docs/lifelong-health-archive-runbook.md', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);

  assert.match(runbook, /philippeho-health-hub-raw-archive/);
  assert.match(runbook, /philippeho-coolify-db-backups/);
  assert.match(runbook, /Indefinite bucket-lock rule for prefix `health-hub\/raw\/v1\/`/);
  assert.match(runbook, /No lifecycle deletion rule/);
  assert.match(runbook, /`03:00`, retain 7 local copies, save to R2, retain 30 R2 copies/);
  assert.match(runbook, /03:30` on day 1, R2 only, retain 12 R2 copies/);
  assert.match(runbook, /Quarterly restore drills/);
  assert.match(runbook, /Legacy table removal approved/);
  assert.match(runbook, /Archive-driven pruning approved/);
  assert.match(environment, /^HEALTH_ARCHIVE_ENABLED=false$/m);
  assert.match(environment, /^HEALTH_RAW_PRUNING_ENABLED=false$/m);
});
