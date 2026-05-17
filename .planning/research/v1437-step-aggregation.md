---
file: .planning/research/v1437-step-aggregation.md
purpose: v1.4.37 — collapse per-sample step ingest into one daily row + optional drill-down
created: 2026-05-17
contributor: v1437-step-aggregation research agent
---

# Step aggregation for v1.4.37 — list-view + ingest fix

Marc reports the `/measurements` list is "spammed" by Apple-Health
step rows, while the one number he wants ("Wie viele Schritte habe ich
am Tag?") is buried. The v1.5 research
(`v15-r-a-step-aggregation.md`) already recommended the canonical
fix: iOS pre-aggregates daily via `HKStatisticsCollectionQuery`. That
recommendation is **still not wired into the iOS app**
(`HealthKitService.swift` L117 inserts `stepCount`; L279 hands it to
`HKAnchoredObjectQuery`; L364's `preferredFrequency` defaults to
`.hourly`). The server-side drain helper exists
(`src/lib/measurements/drain-per-sample-cumulative.ts`) but only runs
when an admin invokes it. The DB keeps accumulating per-sample rows;
the list view keeps painting them.

v1.4.37 ships a list-view "one row per day, expandable" overlay plus
an auto-scheduled drain — both server-only, no iOS release required.

## Current HealthLog behaviour (with code paths)

### How step samples enter the DB

1. **iOS read** — `HealthKitService.swift` (active build) sets up an
   `HKObserverQuery` per cumulative type with
   `preferredFrequency = .hourly`. Each wake-up runs an
   `HKAnchoredObjectQuery` that emits one `HKQuantitySample` per chunk
   the Watch's pedometer wrote — 50–200 samples/day for an Apple-Watch
   wearer, 1–24 for iPhone-only.
2. **Wire conversion** — `HealthKitWireConverter.swift::quantityEntry`
   builds one `HealthKitBatchEntryDTO` per sample with
   `externalId = sample.uuid.uuidString`.
3. **Server ingest** — `POST /api/measurements/batch` writes one
   `Measurement` row per `HKSample.uuid`. Dedup is via the unique
   index `(userId, type, source, externalId)`.
4. **Storage shape** — `type = ACTIVITY_STEPS`, `source = APPLE_HEALTH`,
   `unit = "steps"`, `value` = per-sample chunk count. One row per
   chunk.

For Marc's 311 779-measurement account, steps + the four sibling
cumulative types plausibly account for **70–80 % of total row count**
— steps alone is the chattiest.

### Read paths that touch step rows

- **`GET /api/measurements` (list view)** —
  `src/app/api/measurements/route.ts` L232–240 runs `findMany` with no
  aggregation; one step sample → one row. PAGE_SIZE = 25 in
  `src/components/measurements/measurement-list.tsx`, so several
  screens of step rows pass before any non-step entry shows up.
- **`GET /api/measurements?aggregate=daily&type=ACTIVITY_STEPS`** —
  L165–230. v1.4.36 W4c routes cumulative types through `SUM(value)`
  (`useSum` branch at L188). Correct, but only when the chart code
  passes `aggregate=daily`.
- **`GET /api/measurements?source=rollup&aggregate=daily&...`** —
  L103–163 reads from `measurement_rollups` and reconstructs the
  daily sum as `mean * count` (L137). Used by the Insights chart row.
- **Dashboard tile (Steps)** — `pickCumulativeDaySum`
  (`cumulative-day-sum.ts`) called from `analytics/route.ts` L270.
  Bucket-and-sum across the day's per-sample rows. v1.4.36 W4c fixed
  the tile so it shows the day's total instead of the latest chunk.
- **Rollup populator** —
  `recomputeBucketsForMeasurement` fires inline on every batch write.
  One DAY bucket per `(user, type, day)`; for cumulative types the
  bucket stores `mean` and `count`, read code reconstructs the sum.

### What the user sees today on `/measurements`

The list view is the only surface still showing raw per-sample step
rows. Every other surface (dashboard tile, Insights chart, Coach
snapshot, weekly report) reads through a day-summing path. The list
page renders the raw `Measurement` table because it's the audit /
edit / delete surface — and the iOS ingest doesn't pre-aggregate, so
the table is full of chunks.

## How the leaders do it (per-platform notes)

| Platform | Top-level display | Drilldown affordance | Storage shape (visible to the user) |
| --- | --- | --- | --- |
| **Apple Health.app** | One bar per day on the "Steps" detail screen. Range tabs: `H / D / W / M / 6M / Y`. Default = `D`. Today's number as a headline above the chart. | Tap `H` → 24-bar hourly chart of today. Tap any day's bar → that day's hourly breakdown. "Show All Data" (buried under Data Sources) reveals the per-sample list — rare debug surface. | Per-sample timeline is **never the default**. |
| **Garmin Connect** | Daily steps tile with goal arc. Tap → "Steps" detail with a 24-bar intensity histogram (15-min buckets, intensity-coloured). | The hourly histogram **is** the detail — no per-sample drill. | One row per day persistent; 15-min histogram computed on-demand from device FIT file. |
| **Oura** | Daily total in the Activity tab. | Tap "Daily Activity" → 24-bar hourly chart. No per-sample drill. | Daily roll-up + sparse hourly histogram. |
| **Withings Health Mate** | Daily steps card + weekly sparkline. Tap → detail page with per-day breakdown. | Hourly intraday bar chart at the bottom of the day detail. | API `getactivity` returns one entry per day; intraday is a separate gated `getintradayactivity` call. |
| **Fitbit** | Today's steps headline. Daily bar chart on the Steps detail page. | Tap any day's bar → hourly intraday view (1- / 5- / 15-min buckets via the intraday API). | One daily total + optional intraday minute stream. |
| **Google Fit** | Daily steps card. Tap → daily bars. | Hourly intraday distribution as a secondary chart. | REST `aggregate` defaults to per-day; per-minute requires explicit `bucketByTime`. |

**Universal pattern**: every consumer health app shows **one number
per day** as the primary view. Drill-down is one tap to a 24-bar
hourly histogram — never a flat list of per-sample timestamps. The
per-sample timeline is either invisible or gated behind a
developer-only API. **Nobody lists per-sample chunks as the default
measurement view.**

## HealthKit primitives + dedup notes

### The right query for daily totals

`HKStatisticsCollectionQuery` with `options: .cumulativeSum` +
`intervalComponents: DateComponents(day: 1)` is Apple's documented
primitive for the day's total step count. Key properties (per WWDC20
"Beyond counting steps" + the Apple Developer Documentation):

- With both an iPhone and an Apple Watch on the same Apple-ID,
  **HealthKit applies its cross-source merge automatically** through
  this query. Health.app uses the same primitive. The merge prefers
  Apple Watch samples for on-wrist intervals and falls back to iPhone
  for unworn intervals.
- The merge state is **not exposed** to clients. There is no public
  API to ask "was the watch worn at 14:32?". Re-implementing the
  merge server-side is intractable — this is why the deep-dive
  research locks "client-side aggregation" as the only correct path.
- HK caches per-day sums on-device, so a 30-day window returns 30
  pre-computed `HKStatistics`.
- Late-arriving samples (Watch syncs at 14:00 with morning data) fire
  the `statisticsUpdateHandler` callback for the affected day.

### Per-sample dedup is impossible without HK's merge

`HKAnchoredObjectQuery` (current iOS path) emits every
`HKQuantitySample` per source. Two facts break server-side dedup:

1. Watch + iPhone overlap on minutes when both track the user.
   HealthKit tracks watch-on-wrist seconds and discards the phone's
   chunks; the server can't see this signal.
2. Each `HKSample.uuid` is unique per device — the same physical step
   gets two UUIDs if both devices recorded it. The current
   `(userId, type, source, externalId)` unique index treats them as
   distinct rows, so the day-sum from per-sample rows double-counts.

`pickCumulativeDaySum` papers over this by summing every per-sample
row without dedup — the dashboard tile silently over-reports when
both watch + phone contributed on the same day. This is a latent
correctness bug worth fixing in the same release.

### Source comparison + priority

`pickCanonicalSourceRows` (`src/lib/analytics/source-priority.ts`)
applies the user's per-(metric, day) source priority. For steps the
ladder is APPLE_HEALTH vs WITHINGS vs MANUAL:

- **Withings** lands **one row per day** (via
  `sync-activity.ts`), keyed to noon-UTC of the day.
- **Apple Health** lands per-sample rows — asymmetric.
- **Manual** entries are rare.

Day-sum reduction must happen per source before the priority ladder
picks. Today's chain is `pickCanonicalSourceRows` then
`pickCumulativeDaySum`. Correct in principle but the double-count
leaks into every APPLE_HEALTH-priority-wins day.

## Recommendation for v1.4.37

**Two-part fix, both server-only (no iOS release needed for v1.4.37):**

### Part 1 — list-view "day grouping" overlay (visible fix)

For `ACTIVITY_STEPS` + the other four `CUMULATIVE_DAY_SUM_TYPES`, the
default list view shows **one row per day** (sum). Per-sample chunks
become children of an expandable row.

- **New mode**: `GET /api/measurements?type=ACTIVITY_STEPS&groupBy=day`
  returns one synthesised row per user-TZ day with `value` = sum,
  `measuredAt` = canonical day timestamp (noon-user-TZ — reuses
  `canonicalDailyTimestamp` from the drain), `sampleCount`, stable
  `dayKey`.
- **Drill-down**: `GET /api/measurements?type=ACTIVITY_STEPS&dayKey=YYYY-MM-DD`
  returns per-sample rows for that one day. Bounded (≤ few hundred).
- **List component**: filter to cumulative type → render grouped rows
  with a chevron that fetches + inlines per-sample on click. Default
  collapsed.
- For `ALL` filter: collapse cumulative-type rows into the day-grouped
  form so the scroll isn't dominated by chunks. Marc's "creativity
  windows" case is satisfied via the chevron.

### Part 2 — server-side scheduled drain (storage fix)

Run `drainPerSampleCumulative` on a pg-boss schedule (nightly). Today
it only runs when an admin invokes the CLI — and the prod-image
tsx + Prisma symlink hack documented in
`feedback_prod_image_tsx_prisma_gap.md` makes that unreliable.

After the scheduled drain:

- Per-sample APPLE_HEALTH cumulative rows older than the drain cutoff
  collapse into one row per day per type with
  `externalId = stats:<HKIdentifier>:<YYYY-MM-DD>`.
- Today's data stays per-sample so late Watch syncs land in real time.
- Idempotent — re-runs are no-ops on already-collapsed days.

Shrinks step row count ~50–200× and makes the list-view grouping
query fast on every range. Also fixes the latent double-count once
per-sample rows are gone.

### Should sample-level writes be suppressed at ingest?

**No, not in v1.4.37.** The right fix is the iOS-side
`HKStatisticsCollectionQuery` switch (v1.5 R-A's Option A); the drain
plus list grouping reach user-visible parity without it. Suppressing
per-sample writes server-side would also break today's iOS build —
the app cannot emit a cumulative DTO without the statistics-query
rework.

### Source-priority interaction

The drain only touches APPLE_HEALTH rows. WITHINGS daily rows
untouched; MANUAL untouched. After the drain every source carries
one row per day per type — a clean ladder for
`pickCanonicalSourceRows` without the per-sample double-count.

## Concrete implementation outline (file paths + components to touch)

### Server (4 files)

1. **`src/lib/validations/measurement.ts`** — extend
   `listMeasurementsSchema` with `groupBy: "day"` and `dayKey: /^\d{4}-\d{2}-\d{2}$/`
   (gated to cumulative types via `superRefine`).

2. **`src/app/api/measurements/route.ts`** — third branch alongside the
   `source=rollup` and `aggregate=daily` paths:
   - `groupBy=day` + cumulative type → query in-window rows, run
     `pickCumulativeDaySum`, return one row per day with `sampleCount`
     + `dayKey`. Prefer `measurement_rollups` DAY granularity when
     `source=rollup` is also set.
   - `dayKey=…` + cumulative type → `findMany` for that day's
     per-sample rows, no aggregation.
   - Neither set → existing behaviour.

3. **`src/components/measurements/measurement-list.tsx`** — render
   grouped rows when `sampleCount > 1`. Chevron column for cumulative
   types; chevron click fires a second `useQuery` against `dayKey=…`
   and inlines the per-sample rows. For the `ALL` filter, query
   cumulative types with `groupBy=day` and the rest with the existing
   call, merge by `measuredAt`.

4. **pg-boss schedule registration** — register
   `drain-per-sample-cumulative` to run nightly at 03:00 UTC, invoking
   `drainPerSampleCumulative(prisma)` with `dryRun: false`. Wrap in
   try/catch + audit log.

### iOS (0 files for v1.4.37; v1.5 keeps the R-A plan)

The iOS rework stays on the v1.5 roadmap. v1.4.37 ships without
touching the iOS bundle. The drain + list-grouping closes the
user-visible bug; the iOS statistics-query switch closes the ingest
volume.

### Tests (3 files)

- **`cumulative-day-sum.test.ts`** — add a two-sources-same-day
  test (the function currently double-counts).
- **`api/measurements/__tests__/group-by-day.test.ts`** (new) — happy
  path the `groupBy=day` and `dayKey=…` modes.
- **`measurement-list-step-grouping.test.tsx`** (new) — render with
  mocked grouped response, click chevron, assert drill-down rows
  render.

## Open questions for Marc

1. **`ALL` filter grouping.** Should cumulative-type rows still
   collapse when the type filter is `ALL`? Recommendation: yes —
   that's the spam-reduction win. The chevron is the escape hatch for
   power users.

2. **Drain cutoff for "today".** The drain leaves recent rows alone
   for real-time visibility. Recommendation: drain anything older
   than **36 h** so late watch syncs have a full day's grace.

3. **Manual deletion of a collapsed daily row.** Once a day is
   drained the per-sample children are gone; deleting the daily row
   drops the whole day. Recommendation: document this in the delete
   confirmation copy.

4. **Other cumulative types.** Fix applies uniformly to
   ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE,
   TIME_IN_DAYLIGHT. Recommendation: ship all five — code change is
   identical and they share the same spam.

5. **"When am I most active?" creativity-window card.** Marc's
   drill-down need is met by the chevron, but a dedicated Insights
   card ("you walked most between 14:00–16:00") is out of scope here.
   Worth a v1.4.38 candidate once the v1.5 iOS rework lands and the
   hourly distribution arrives as `HKStatisticsCollectionQuery` with
   `intervalComponents = .hour`.
