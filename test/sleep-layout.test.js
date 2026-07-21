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

test('Today keeps only Asleep and Efficiency beside the primary sleep duration', async () => {
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
    /<dt id="sleepMetricLabel">Sleep<\/dt><dd id="sleepSummaryHeading"><span id="sleepDuration">/,
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

test('Sleep workspace heading removes its description and page-level range controls', async () => {
  const { html } = await sources();
  const sleepView = html.slice(
    html.indexOf('<section id="view-sleep"'),
    html.indexOf('<section id="view-heart"'),
  );

  assert.match(sleepView, /<p class="view-kicker">Sleep workspace<\/p><h1>Sleep<\/h1>/);
  assert.doesNotMatch(sleepView, /Chronology first/);
  assert.doesNotMatch(sleepView, /data-range-tabs="sleep"/);
});

test('selected-night summary uses six balanced cells with time beside Sleep period', async () => {
  const { app } = await sources();

  assert.match(app, /class="workspace-summary sleep-workspace-summary"/);
  assert.match(app, /class="sleep-period-heading"/);
  assert.match(app, /<span>Sleep period<\/span><small>\$\{formatTime\(selected\.startTime\)\}–\$\{formatTime\(selected\.endTime\)\}<\/small>/);
  assert.match(app, /<dt>Asleep<\/dt>/);
  assert.match(app, /<dt>Awake<\/dt>/);
  assert.match(app, /<dt>Efficiency<\/dt>/);
  assert.match(app, /<dt>Fell asleep<\/dt>/);
  assert.match(app, /<dt>Awake episodes<\/dt>/);
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

test('Sleep trend defaults to seven days and owns its three local range controls', async () => {
  const { app } = await sources();

  assert.match(app, /sleepTrendPeriod: '7-days'/);
  assert.match(app, /\['7-days', '7 days'\]/);
  assert.match(app, /\['1-month', '1 month'\]/);
  assert.match(app, /\['1-year', '1 year'\]/);
  assert.match(app, /data-sleep-trend-period="\$\{value\}"/);
  assert.doesNotMatch(app, /ranges:\s*\{\s*sleep:/);
  assert.doesNotMatch(app, /metric === 'sleep'/);
});

test('Sleep duration trend renders horizontal rows with a seven-hour target marker', async () => {
  const { app } = await sources();

  assert.match(app, /class="sleep-trend-row is-\$\{row\.targetState\}"/);
  assert.match(app, /class="sleep-trend-rail"/);
  assert.match(app, /class="sleep-target-marker"/);
  assert.match(app, /7h target/);
  assert.match(app, /Below 7h target/);
  assert.match(app, /Target reached/);
  assert.doesNotMatch(app, /trendBars\(\[\.\.\.data\.sessions\]\.reverse\(\), 'durationMinutes'/);
});
