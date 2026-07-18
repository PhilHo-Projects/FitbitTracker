# Sleep Layout and Trends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compact the Today and Sleep summaries and replace the generic vertical sleep chart with horizontal 7-day, four-week, and twelve-month duration comparisons against a seven-hour target.

**Architecture:** Keep the existing no-framework browser application. Add pure range, aggregation, and scale helpers to `public/health-ui.js`; render the resulting rows in `public/app.js`; update existing HTML/CSS structure without changing the API or database.

**Tech Stack:** Browser ES modules, semantic HTML, custom CSS compiled through Tailwind CLI, Node's built-in test runner, Playwright CLI.

## Global Constraints

- The seven-hour line is a personal target, not a medical recommendation or score.
- Missing nights are excluded from averages and never treated as zero.
- The one-month view is four consecutive rolling seven-day blocks ending on the selected date.
- The one-year view is twelve calendar months ending with the selected month.
- Heart and Calories range behavior remains unchanged.
- No database schema, ingestion, or export changes.
- The trend must not require horizontal scrolling at phone widths.

---

### Task 1: Sleep trend data model

**Files:**
- Modify: `public/health-ui.js`
- Modify: `test/health-ui.test.js`

**Interfaces:**
- Produces: `sleepTrendRange(period, selectedDate) -> { startDate, endDateExclusive }`
- Produces: `buildSleepTrendRows(sessions, period, selectedDate) -> Array<{ key, label, startDate, endDateExclusive, durationMinutes, recordedNights }>`
- Produces: `scaleSleepTrendRows(rows, targetMinutes = 420) -> { maximumMinutes, targetPercent, rows }`

- [ ] **Step 1: Write failing range and aggregation tests**

Add tests proving:

```js
assert.deepEqual(sleepTrendRange('7-days', '2026-07-16'), {
  startDate: '2026-07-10',
  endDateExclusive: '2026-07-17',
});
assert.deepEqual(sleepTrendRange('1-month', '2026-07-16'), {
  startDate: '2026-06-19',
  endDateExclusive: '2026-07-17',
});
assert.deepEqual(sleepTrendRange('1-year', '2026-07-16'), {
  startDate: '2025-08-01',
  endDateExclusive: '2026-08-01',
});
```

Add fixtures that prove seven daily rows, four seven-day averages, twelve monthly averages, and missing periods.

- [ ] **Step 2: Run the helper tests and verify RED**

Run: `node --test test/health-ui.test.js`

Expected: FAIL because the new helpers are not exported.

- [ ] **Step 3: Implement date ranges and aggregation**

Use UTC-noon civil-date arithmetic. Build a date-to-primary-session map, average only finite recorded durations, and return rows oldest to newest with English weekday/month labels and Week 1–Week 4 labels.

- [ ] **Step 4: Add and test target scaling**

Use a minimum scale ceiling of 540 minutes. Expand the ceiling to the next full hour when a row exceeds 540 minutes. Return `targetPercent` and per-row `fillPercent`, clamped to 100.

- [ ] **Step 5: Run helper tests and verify GREEN**

Run: `node --test test/health-ui.test.js`

Expected: all health UI tests pass.

### Task 2: Compact Today and rebalance the selected-night summary

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Create: `test/sleep-layout.test.js`

**Interfaces:**
- Consumes: existing dashboard sleep contract.
- Produces: Today heading facts with only `sleepAsleep` and `sleepEfficiency`.
- Produces: six balanced selected-night summary cells.

- [ ] **Step 1: Write failing markup regressions**

Assert that the Today sleep section has `sleep-heading-facts`, no `sleepAwake`, and no `inline-facts`; assert the Sleep heading has no description and no `data-range-tabs="sleep"`.

- [ ] **Step 2: Run markup tests and verify RED**

Run: `node --test test/sleep-layout.test.js`

Expected: FAIL against the current Today facts and Sleep heading.

- [ ] **Step 3: Update Today markup and renderer**

Move Asleep and Efficiency into the sleep panel heading beside duration, remove Awake and the bottom fact row, and stop assigning `sleepAwake` in `renderToday`.

- [ ] **Step 4: Update Sleep heading and selected-night summary**

Remove the Sleep description and page-level range tabs. Render a `sleep-workspace-summary` with a period cell whose label and bed/wake time share one row, followed by Asleep, Awake, Efficiency, Fell asleep, and Awake episodes.

- [ ] **Step 5: Run markup tests and verify GREEN**

Run: `node --test test/sleep-layout.test.js`

Expected: all sleep layout markup tests pass.

### Task 3: Horizontal trend interaction and rendering

**Files:**
- Modify: `public/app.js`
- Modify: `test/sleep-layout.test.js`

**Interfaces:**
- Consumes: `sleepTrendRange`, `buildSleepTrendRows`, and `scaleSleepTrendRows`.
- Produces: local state `sleepTrendPeriod` with values `7-days`, `1-month`, or `1-year`.

- [ ] **Step 1: Write failing rendering/state regressions**

Assert that the browser source contains the three approved trend controls, uses horizontal `sleep-trend-row` markup, and defaults `sleepTrendPeriod` to `7-days`.

- [ ] **Step 2: Run the regressions and verify RED**

Run: `node --test test/sleep-layout.test.js`

Expected: FAIL because the current code uses `trendBars` and page-level sleep presets.

- [ ] **Step 3: Implement horizontal trend markup**

Request the helper-provided range, aggregate the returned sessions, and render one label/rail/value row per period. Add one seven-hour target marker to each rail and textual `Below target`, `Target reached`, or `Missing` context.

- [ ] **Step 4: Implement section-local controls**

Delegate clicks from `#sleepWorkspace` to `[data-sleep-trend-period]`, update the selected button and state, then reload only the Sleep workspace.

- [ ] **Step 5: Run regressions and verify GREEN**

Run: `node --test test/health-ui.test.js test/sleep-layout.test.js`

Expected: both suites pass.

### Task 4: Responsive layout and visual verification

**Files:**
- Modify: `src/input.css`
- Modify: `test/responsive-css.test.js`
- Modify: `TIMELINE.md` (ignored private project log)

**Interfaces:**
- Produces: compact desktop Today card, balanced six-cell Sleep summary, and non-scrolling horizontal trend rows.

- [ ] **Step 1: Write failing CSS regressions**

Assert the CSS includes:

```css
.sleep-heading-facts
.sleep-workspace-summary
.sleep-trend-row
.sleep-trend-rail
overflow-x: visible
```

Assert phone rules collapse the summary to two columns and the trend row to label/value plus a full-width rail.

- [ ] **Step 2: Run CSS tests and verify RED**

Run: `node --test test/responsive-css.test.js`

Expected: FAIL because the new selectors do not exist.

- [ ] **Step 3: Implement desktop and phone styles**

Use the existing spacing/color tokens. Keep the duration primary, make the facts compact, style below-target rails amber and at-target rails green, and provide 44-pixel trend controls on phones.

- [ ] **Step 4: Build and run automated verification**

Run:

```powershell
npm test
npm run build
git diff --check
```

Expected: zero test failures, successful Tailwind build, and no whitespace errors.

- [ ] **Step 5: Verify in a real browser**

Run fixture preview, log in with `0000`, and inspect Today and Sleep at desktop and phone widths. Exercise `7 days`, `1 month`, and `1 year`; confirm no horizontal overflow or console errors.

- [ ] **Step 6: Record verification**

Update `TIMELINE.md` with the compact layout change, aggregation behavior, commands run, and browser viewport results.
