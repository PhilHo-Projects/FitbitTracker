# Health data inspector and calorie transparency — design direction

**Date:** 2026-07-23
**Status:** Product direction and handoff for a separate feature task. No implementation is part of
the brainstorming task that produced this document.

## Product intent

FitbitTracker should use Google Health as a data source without becoming a clone of the Google
Health app. Google provides useful summaries, but it often presents inferred values with little
explanation. This product should instead make the path from source data to displayed conclusion
inspectable:

1. What Google returned.
2. What the application normalized and stored.
3. What the application derived.
4. What remains unknown or inferred.

The immediate concept is a folded, read-only **Nerd details** or **Data inspector** view within each
health category. The daily view remains approachable, while an interested user can expand a
category to see the data structure, provenance, coverage, transformations, and relevant source
metadata behind it.

Calories are the first and clearest transparency case, but the inspector should be a reusable
cross-category pattern rather than a calorie-only component.

## Recommended scope

Build a daily inspection board around the metrics the application currently ingests. Separately
inventory additional Google Health data types that could enrich those metrics, but do not treat
every API-supported data type as an implementation requirement.

This boundary avoids two weak alternatives:

- A calorie-only explanation would solve the immediate mystery but create another one-off UI.
- A browser for every Google Health data type would become an API catalog rather than a useful
  personal health product.

The first implementation task should therefore validate one representative daily board, with
calories as the deepest example, while defining a reusable disclosure pattern for Sleep and Heart.

## Daily inspection board

Each category's collapsed view continues to show its normal summary. Expanding **Nerd details**
reveals four progressively more technical layers:

### 1. Source facts

- Metric and Google Health data type name.
- Source device/application metadata when Google supplies it.
- Time interval or sample timestamps.
- Measurement unit.
- Number of source points.
- Coverage window and known gaps.

### 2. Normalized records

Show the application's stable representation of the source data. This should be a formatted table
or concise structured view, not merely a large JSON dump. Examples include a sleep stage interval,
a heart-rate sample, and an active-calorie interval.

### 3. Derived values

Every application-created value should identify its formula or transformation. Examples:

- `total calories = active energy + basal energy` when the Google total is unavailable.
- Daily heart minimum, maximum, average, sample count, and coverage derived from raw samples.
- Sleep duration and stage percentages derived from session intervals.

Derived values must not be presented as direct Google measurements.

### 4. Redacted source JSON

An optional final disclosure shows the preserved upstream structure for debugging and exploration.
It is collapsed by default, formatted for readability, and explicitly labelled as source data.
Identifiers, authorization material, and any field that is unnecessary for personal analysis must
be redacted. The UI must never expose secrets or confuse an upstream payload with a stable public
contract. Exact upstream fields are retention-dependent: when an older interval is available only
as a normalized compact record or archive export, the inspector shows that limitation instead of
inventing or reconstructing source JSON.

## Calorie transparency

### What the project already has

The current Google Health pipeline requests and stores separate interval streams for:

- `active-energy-burned`
- `basal-energy-burned`

The current local dataset contains one active and one basal record per hour. The database keeps
their source interval, value, type, device metadata, and original source fields. The daily and
hourly calorie UI already keeps active and basal energy separate.

At the time of this design note, Google Health's `total-calories` rollup request is retained in the
gateway but omitted from default synchronization because the documented request has returned
`400 Invalid time range`. The application therefore derives a total from active plus basal energy
and records that the total was derived.

An eight-complete-day local inspection observed the following averages:

```text
Google basal-energy estimate     1,747 kcal/day
Google active-energy estimate      631 kcal/day
Application-derived total        2,378 kcal/day
```

This snapshot is evidence for the feature question, not a permanent personal baseline.

### What the data does not expose

Google does not attribute each active calorie to a particular sensor or algorithm input. The
application cannot honestly divide active energy into:

- inferred from wrist movement;
- inferred from heart rate;
- inferred from steps or an exercise classification.

Any such attribution would be invented precision. Google performs that sensor fusion upstream and
returns one active-energy estimate for the interval.

### Useful additional context

The Google Health API also documents `calories-in-heart-rate-zone`, which returns kilocalories
allocated to heart-rate zones through rollup operations. This is useful context, but it is not proof
that those calories were calculated exclusively from heart-rate readings.

A future calorie board may also align the existing hourly active/basal records with separately
obtained:

- heart-rate samples and hourly summaries;
- steps;
- activity level and active minutes;
- time in heart-rate zones;
- recorded exercise sessions.

The board may say that values **coincide with** or are **consistent with** supporting signals. It
must not claim that those signals caused Google's estimate.

An illustrative hour could read:

```text
12:00–13:00
Basal energy                 73 kcal  Google estimate
Active energy               20 kcal  Google estimate
Average heart rate          71 bpm   derived from 48 samples
Steps                      840       Google interval data
Heart-rate-zone calories     —       not currently synchronized
Total                       93 kcal  derived: basal + active
```

## Category inventory

The separate feature task should begin by producing a compact inventory with four states:

- **Ingested:** source data is synchronized and stored now.
- **Derived:** the application calculates it from ingested records.
- **API-available:** Google documents it, but the application does not currently ingest it.
- **Unavailable/unknown:** not returned for this account/device or not attributable from Google's
  output.

The initial inventory should cover:

### Sleep

- Sessions, stages, stage intervals, session duration, and source/device metadata.
- Classic-sleep fallback and the distinction between Google stages and application-derived
  percentages.
- Coverage, missing stages, and uncertain wearable inference.

### Heart

- Exact heart-rate samples and timestamps.
- Daily resting heart rate.
- Application-derived minimum, maximum, average, sample count, and coverage.
- API-available heart-rate-zone, HRV, oxygen, and related context only when the current Google
  documentation and account payload support them.

### Calories

- Hourly active and basal intervals.
- Derived daily/hourly totals and their derivation flag.
- API-available calories by heart-rate zone and contextual activity metrics.
- Explicit absence of sensor-level attribution.

### Journal and context

- User-authored timestamps, encrypted text, tags, and revisions.
- Clear separation from Google-provided health data.
- Original free text remains authoritative if AI later extracts structured tags.

### Profile and source

- Timezone, profile fields used by Google, membership start date, device/application source, and
  sync coverage where available.
- Sensitive identifiers remain redacted in the browser.

## Interaction principles

- Technical detail is opt-in and collapsed by default.
- The normal dashboard remains useful without opening the inspector.
- Labels distinguish **observed**, **Google inferred**, **application derived**, and
  **user reported**.
- Missing data is different from a measured zero.
- Coverage and data age are visible.
- JSON is evidence and a debugging aid, not the primary visualization.
- Exact field names may be shown in the inspector without leaking them into the friendly summary.
- Mobile use remains possible; dense tables may scroll horizontally inside the disclosure rather
  than widening the full page.

## Required discovery before implementation

The separate task must verify the design against:

1. Current Google Health API documentation for each candidate data type and operation.
2. The actual upstream payloads already preserved in `source_fields`.
3. Current normalized database records and derivation flags.
4. Existing API responses and the day/range behavior of each workspace.
5. Existing authorization scopes before proposing any new consent.

The discovery output should include one representative, redacted daily data board showing every
currently available field for Sleep, Heart, and Calories. Only after that inventory should the task
decide which additional Google data types are worth synchronizing.

## Success criteria for the future feature

- A user can explain where each displayed daily value came from.
- The inspector reveals the useful structure of a daily entry without overwhelming the primary
  dashboard.
- Active and basal calories are visibly separate.
- Derived totals and other application computations identify their formulas.
- Google inference is never relabelled as direct measurement.
- Retained raw/source structure is available safely and readably; older compact data clearly
  reports when the original payload is no longer online.
- The cross-category pattern can grow as additional metrics are ingested.

## Out of scope for this design direction

- Implementing the feature in the brainstorming task.
- Claiming clinical accuracy or diagnosing health conditions.
- Reverse-engineering Google's proprietary sensor-fusion algorithm.
- Enabling archive execution, pruning, read cutover, compact writes, table removal, or production
  tuning gates.
- Ingesting every Google Health API data type merely because it exists.

## Source references

- Google Health calories and energy data types:
  <https://developers.google.com/health/data-types/calories>
- Google Health calorie-by-heart-rate-zone rollup:
  <https://developers.google.com/health/reference/rest/v4/CaloriesInHeartRateZoneRollupValue>
- Current calorie normalization:
  `lib/metrics/normalizers.js`
- Current daily/hourly calorie queries:
  `lib/db/health-repository.js`
- Current product and synchronization behavior:
  `README.md`
