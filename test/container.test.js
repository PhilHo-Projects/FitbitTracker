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
  assert.match(dockerfile, /COPY --from=build \/app\/db \.\/db/);
  assert.match(dockerfile, /COPY --from=build \/app\/scripts \.\/scripts/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends curl/);
  assert.match(dockerfile, /HEALTHCHECK .*\/readyz/);
  assert.match(dockerignore, /^\.runtime$/m);
  assert.match(dockerignore, /^output$/m);
  assert.match(server, /SYNC_INTERVAL_HOURS/);
  assert.match(server, /SYNC_SCHEDULE_LOOKBACK_DAYS/);
  assert.match(server, /RAW_RETENTION_DAYS/);
  assert.match(server, /HEALTH_COMPACT_WRITES_ENABLED === 'true'/);
  assert.match(server, /HEALTH_RAW_PRUNING_ENABLED === 'true'/);
});
