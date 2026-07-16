# Sleep Layout and Trends — Design

## Goal

Make the Today sleep summary and Sleep workspace denser, better proportioned, and easier to scan.
Replace the generic vertical sleep-duration chart with horizontal comparisons against the user's
preferred seven-hour sleep target.

## Today sleep summary

- Keep the sleep duration as the primary value on the left.
- Place only Asleep and Efficiency immediately to its right in the heading area.
- Remove the separate Awake fact and the bottom inline-facts section.
- Keep the proportional sleep-stage bar and four-column Awake, Light, Deep, and REM breakdown.
- Reduce the panel's desktop minimum height so the removed facts do not leave unused space.
- On narrow screens, allow the duration and two facts to wrap without compromising touch targets or
  the four-column stage summary.

## Sleep workspace heading

- Keep the “Sleep workspace” kicker and “Sleep” title.
- Remove the descriptive sentence under the title.
- Remove the page-level Day, Week, Month, and Year controls from the Sleep workspace only.
- Heart and Calories retain their existing page-level range controls.

## Selected-night summary

- Use one balanced summary row rather than a dominant left block and five compressed right columns.
- The Sleep period cell contains:
  - the label “Sleep period” on the left;
  - the bed-to-wake time aligned to the right of that label;
  - the total duration as the primary value beneath them.
- Retain Asleep, Awake, Efficiency, Fell asleep, and Awake episodes.
- Give the six summary cells comparable width and visual weight while keeping total duration the
  strongest value.
- Collapse to two columns on phones.

## Sleep duration trend

The trend panel is always present beneath the selected night's chronology.

### Controls

- Controls live inside the trend panel only.
- Available periods are:
  - `7 days` — default;
  - `1 month`;
  - `1 year`.
- Changing the trend period reloads only the sleep workspace and does not alter the selected date.

### Data ranges and aggregation

- `7 days` requests the selected date and previous six civil dates, producing up to seven daily rows.
- `1 month` requests 28 days and groups them into four consecutive rolling seven-day blocks ending
  on the selected date. Rows are ordered oldest to newest and labeled Week 1 through Week 4.
- `1 year` requests the selected calendar month and previous eleven calendar months. Each row is the
  average duration for recorded nights in that calendar month and is labeled with the month name.
- Missing nights are excluded from averages and are never treated as zero.
- A daily or aggregate period with no records is shown as Missing.
- Multiple sleep sessions on one date use the primary nightly session returned by the archive.

### Visualization

- Use one horizontal rail per day, week block, or month.
- Row order runs top to bottom, oldest to newest.
- Each row shows its label at the left and formatted duration at the right.
- A shared scale makes every row within the selected view directly comparable.
- The scale has a minimum ceiling above seven hours and expands when an observed average exceeds it.
- A clearly labeled vertical marker indicates the seven-hour target on every rail.
- Fill color communicates relation to the target:
  - below target: restrained warm/amber;
  - at or above target: existing sleep accent green.
- The target is a personal comparison marker, not a medical recommendation or score.

## Responsive behavior

- Desktop rows use a label column, flexible rail, and fixed-width value column.
- Phone rows stack the label and value above a full-width rail when necessary.
- The trend never requires horizontal scrolling.
- Controls remain minimum 44-pixel touch targets on mobile.

## Accessibility

- Trend controls use buttons with selected state.
- The trend group has an accessible description that explains the seven-hour target.
- Each rail exposes its period label, duration or Missing state, and relation to target through text,
  not color alone.
- Existing focus styles and reduced-motion behavior remain intact.

## Testing

- Unit-test the seven-day, rolling four-week, and twelve-calendar-month aggregation helpers.
- Test missing-night exclusion and all-missing periods.
- Test scale expansion and seven-hour marker placement.
- Add markup/CSS regressions for:
  - Today containing only Asleep and Efficiency beside duration;
  - removal of Sleep page-level range tabs and description;
  - horizontal trend rows without horizontal overflow.
- Verify at desktop and phone widths against deterministic fixture data.

## Non-goals

- No sleep score.
- No change to ingestion, database schema, or export formats.
- No change to Heart or Calories range behavior.
- No medical claim that seven hours is universally optimal.
