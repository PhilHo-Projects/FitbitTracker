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

async function publicSurfaces() {
  const [login, dashboard, demo, demoScript] = await Promise.all([
    readFile(new URL('../public/login.html', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../prototypes/sleep-ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../prototypes/sleep-ui/demo.js', import.meta.url), 'utf8'),
  ]);
  return { login, dashboard, demo, demoScript };
}

test('Sleep Tracker uses a concise landing page with a public demo entry point', async () => {
  const { login, dashboard } = await publicSurfaces();

  assert.match(login, /<h1 id="loginHeading">Sleep Tracker<\/h1>/);
  assert.match(login, /Understand your nights, follow your sleep trends, and explore what changes alongside them\./);
  assert.match(login, /href="\/demo"/);
  assert.doesNotMatch(login, /See your nights|lens-welcome-points|login-privacy/);
  assert.match(dashboard, /<strong>Sleep Tracker<\/strong>/);
  assert.doesNotMatch(dashboard, /Sleep Lens/);
});

test('the public demo is synthetic and cannot call private APIs', async () => {
  const { demo, demoScript } = await publicSurfaces();

  assert.match(demo, /Public demo · synthetic data/);
  assert.match(demo, /href="\/login"/);
  assert.doesNotMatch(demo, /data-page="journal"|data-page="settings"|data-layout=/);
  assert.doesNotMatch(demoScript, /\bfetch\s*\(|\/api\//);
  assert.match(demoScript, /Editing is not available in the public demo/);
});

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

test('primary navigation focuses on sleep and Data & settings preserves specialist workspaces', async () => {
  const { html } = await sources();
  const desktopNav = html.slice(
    html.indexOf('<nav class="main-nav"'),
    html.indexOf('</nav>', html.indexOf('<nav class="main-nav"')),
  );
  for (const view of ['sleep', 'trends', 'patterns', 'journal']) {
    assert.match(desktopNav, new RegExp(`data-nav="${view}"`));
  }
  for (const view of ['heart', 'oxygen', 'calories', 'export', 'settings']) {
    assert.doesNotMatch(desktopNav, new RegExp(`data-nav="${view}"`));
    assert.match(html, new RegExp(`data-more-view="${view}"`));
  }
  assert.match(html, /id="moreSyncStatus"/);
  assert.match(html, /id="moreOperationsStatus"/);
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
