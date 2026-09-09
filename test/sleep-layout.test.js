import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function sources() {
  const [html, app, css] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/input.css', import.meta.url), 'utf8'),
  ]);
  return { html, app, css };
}

test('localhost has a hidden-by-default development banner initialized from its hostname', async () => {
  const { html, app, css } = await sources();

  assert.match(
    html,
    /<div id="environmentBanner" class="environment-banner" role="status" hidden>\s*LOCAL DEVELOPMENT\s*<\/div>/,
  );
  assert.match(app, /isLocalDevelopmentHost\(window\.location\.hostname\)/);
  assert.match(css, /\.environment-banner\s*\{/);
  assert.match(css, /\.app-body\.is-local-development \.app-header\s*\{/);
});

test('Today keeps the recorded period and efficiency beside actual sleep', async () => {
  const { html, app } = await sources();
  const todaySleep = html.slice(
    html.indexOf('<section class="metric-panel sleep-summary'),
    html.indexOf('<section class="metric-panel compact-panel'),
  );

  assert.match(todaySleep, /class="sleep-heading-metrics"/);
  assert.match(todaySleep, /id="sleepAsleep"/);
  assert.match(todaySleep, /id="sleepEfficiency"/);
  assert.doesNotMatch(todaySleep, /id="sleepAwake"/);
  assert.doesNotMatch(todaySleep, /class="inline-facts"/);
  assert.doesNotMatch(app, /\$\('#sleepAwake'\)/);
});

test('Today sleep summary aligns equal-size metrics, right-side timing, and a compact full-width row', async () => {
  const { html, css } = await sources();
  const todaySleep = html.slice(
    html.indexOf('<section class="metric-panel sleep-summary'),
    html.indexOf('<section class="metric-panel compact-panel'),
  );
  const sleepSummaryRule = css.match(/\.sleep-summary\s*\{[^}]*\}/s)?.[0] ?? '';

  assert.match(todaySleep, /class="sleep-heading-metrics"/);
  assert.match(
    todaySleep,
    /<dt id="sleepMetricLabel">Actual sleep<\/dt><dd id="sleepSummaryHeading"><span id="sleepDuration">/,
  );
  assert.match(todaySleep, /class="sleep-heading-meta"/);
  assert.match(todaySleep, /id="sleepWindow"/);
  assert.match(sleepSummaryRule, /grid-column:\s*1\s*\/\s*-1/);
  assert.doesNotMatch(sleepSummaryRule, /grid-row:\s*span\s*2/);
  assert.match(css, /\.sleep-heading-metrics dd\s*\{[^}]*font-size:\s*2rem/s);
  assert.match(
    css,
    /\.sleep-heading-meta\s*\{[^}]*justify-self:\s*end[^}]*text-align:\s*right/s,
  );
});





test('Sleep, Heart, and Calories workspace summaries use one shared white-stat size', async () => {
  const { app, css } = await sources();

  assert.match(
    css,
    /\.workspace-summary\s*\{[^}]*--workspace-value-size:\s*1\.125rem/s,
  );
  assert.match(
    css,
    /\.workspace-summary > div > strong,\s*\.workspace-summary dd\s*\{[^}]*font-size:\s*var\(--workspace-value-size\)/s,
  );
  assert.doesNotMatch(css, /\.sleep-workspace-summary dd\s*\{[^}]*font-size:/s);
  assert.match(
    app,
    /<div><span>Resting heart rate<\/span><strong>\$\{numeric\(summary\?\.restingBpm \?\? summary\?\.averageDailyRestingBpm, ' bpm'\)\}<\/strong><\/div>/,
  );
  assert.match(
    app,
    /<div><span>Total expenditure<\/span><strong>\$\{numeric\(summary\?\.totalKcal, ' kcal'\)\}<\/strong><\/div>/,
  );
  assert.doesNotMatch(app, /<small>bpm<\/small>/);
  assert.doesNotMatch(app, /<small>kcal burned<\/small>/);
});
