import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production container applies migrations before starting and includes migration assets', async () => {
  const [packageJson, dockerfile, dockerignore] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
    readFile(new URL('../.dockerignore', import.meta.url), 'utf8'),
  ]);

  assert.equal(packageJson.scripts.start, 'node scripts/start.mjs');
  assert.match(dockerfile, /COPY --from=build \/app\/db \.\/db/);
  assert.match(dockerfile, /COPY --from=build \/app\/scripts \.\/scripts/);
  assert.match(dockerfile, /HEALTHCHECK .*\/healthz/);
  assert.match(dockerignore, /^\.runtime$/m);
  assert.match(dockerignore, /^output$/m);
});
