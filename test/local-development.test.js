import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('local development and fixture preview use the documented 0000 password', async () => {
  const [devScript, previewScript, readme] = await Promise.all([
    readFile(new URL('../scripts/dev.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/preview-fixtures.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
  ]);

  assert.match(devScript, /DASHBOARD_PASSWORD: '0000'/);
  assert.match(devScript, /password: 0000/);
  assert.match(previewScript, /DASHBOARD_PASSWORD: '0000'/);
  assert.match(previewScript, /password: 0000/);
  assert.match(readme, /Local password: `0000`/);
  assert.doesNotMatch(`${devScript}\n${previewScript}\n${readme}`, /health-local/);
});
