import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('phone sleep timeline fits the viewport instead of requiring horizontal scrolling', async () => {
  const css = await readFile(new URL('../src/input.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 680px)'));

  assert.match(mobile, /\.sleep-lanes\s*\{\s*min-width:\s*0/);
  assert.match(mobile, /\.workspace-stage-row\s*\{\s*margin-left:\s*0/);
});

test('sleep summaries and duration trends use compact horizontal layouts', async () => {
  const css = await readFile(new URL('../src/input.css', import.meta.url), 'utf8');

  assert.match(css, /\.sleep-heading-metrics\s*\{[^}]*display:\s*grid/s);
  assert.match(
    css,
    /\.sleep-workspace-summary\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(css, /\.sleep-trend\s*\{[^}]*overflow-x:\s*visible/s);
  assert.match(css, /\.sleep-trend-row\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.sleep-trend-rail\s*\{[^}]*overflow:\s*hidden/s);
});

test('phone sleep summaries collapse to two columns and trend rails stay full width', async () => {
  const css = await readFile(new URL('../src/input.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 680px)'));

  assert.match(
    mobile,
    /\.sleep-workspace-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(mobile, /\.sleep-period-heading span\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(
    mobile,
    /\.sleep-trend-row\s*\{[^}]*grid-template-columns:\s*1fr\s+auto/s,
  );
  assert.match(mobile, /\.sleep-trend-rail\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(mobile, /\.sleep-trend-tabs button\s*\{[^}]*min-height:\s*44px/s);
});
