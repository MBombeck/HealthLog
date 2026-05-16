---
file: .planning/research/v15-r-a-step-aggregation.md
purpose: Research the right daily step aggregation shape for the Apple Health ingest (v1.5)
created: 2026-05-16
contributor: R-A
---

# Step aggregation for the Apple Health ingest — recommendation

## TL;DR

Pick **Option A — iOS pre-aggregates to one row per day per cumulative
metric, using `HKStatisticsCollectionQuery` with daily buckets**. The
server changes are minimal (one new helper to mint a deterministic
`externalId` keyed by `(type, day, deviceType)`, no schema change, no
cron). The iOS change is significant but locally scoped to the cumulative
quantity types (steps, active energy, flights climbed, walking-running
distance, time-in-daylight). The pattern was already recommended by the
v1.4.23 deep-dive (`.planning/research/apple-health-sync-deep-dive.md` §2)
and is the same shape the Withings activity sync writes today — landing
APPLE_HEALTH on parity with WITHINGS for cumulative metrics is the right
strategic frame.

---

## 1. Current path — what lands in the DB today

### iOS side

| Layer | File | Behaviour |
| --- | --- | --- |
| Observer | `HealthLog/Services/HealthKitService.swift` (per-type `HKObserverQuery` → `HKAnchoredObjectQuery`) | Returns every new `HKQuantitySample` since the anchor. Background-delivery frequency for stepCount is `.hourly` (`preferredFrequency` line 364) — fires up to once per hour while the Watch is on the wrist. |
| Wire conversion | `HealthLog/Services/HealthKitWireConverter.swift` (`quantityEntry`) | Builds ONE `HealthKitBatchEntryDTO` per `HKQuantitySample`. Sets `externalId = sample.uuid.uuidString`. |
| Upload | `HealthLog/Repositories/MeasurementBatchUploader.swift` | Chunks ≤500 per `POST /api/measurements/batch`. |

`HKQuantitySample` for stepCount on an Apple Watch wearer arrives every
5-15 minutes (per the watch's pedometer roll-up; per-day count: ~50-200,
per the deep-dive sync research). Each sample becomes one DB row.

### Server side

- `POST /api/measurements/batch` (`src/app/api/measurements/batch/route.ts`)
  — maps every entry through `mapAppleHealthEntry()`, inserts via
  `createMany({ skipDuplicates: true })`. No aggregation.
- `Measurement` schema (`prisma/schema.prisma:363`) — unique index
  `(userId, type, source, externalId)` is per-sample-UUID, so two
  different `HKSample.uuid`s for the same minute land twice.
- `GET /api/measurements/series?kind=steps` (`src/app/api/measurements/series/route.ts`)
  — returns the raw rows, no bucketing, no SUM.
- `GET /api/measurements?type=ACTIVITY_STEPS&aggregate=daily` — runs
  `date_trunc + AVG` in SQL (`route.ts:78-94`). **This is wrong for
  steps** (AVG of per-minute counts, not SUM). Today's chart silently
  understates the daily total when `aggregate=daily` kicks in past the
  90-day threshold.

### Impact

| Concern | Today's cost |
| --- | --- |
| DB rows | 50-200 / user / day for steps alone × five cumulative metrics = ~500-1000 rows / user / day from APPLE_HEALTH. A multi-year backfill writes ~1-2 M rows for a single active user. |
| Read query for `/api/measurements?type=ACTIVITY_STEPS` (30-day default) | 1500-6000 rows over the wire per dashboard page load. |
| Server analytics | `pickCanonicalSourceRows` sums all sibling rows per day per source — works correctly but pays for the row count. |
| Personal-record worker | `enqueuePrDetection` after every batch — per-sample-row noise. |
| Conflict with Withings shape | Withings activity sync (`src/lib/withings/sync-activity.ts:113-302`) already lands ONE row per day for steps with `measuredAt = day-noon-UTC`. APPLE_HEALTH is the only source emitting per-sample step rows. |

The contract today is internally inconsistent — `aggregation: "sum"`
in `apple-health-mapping.ts:181` is documented as "advisory metadata for
downstream summarisation" but no path summarises before storage and the
read-side SQL aggregator uses AVG.

---

## 2. Peer apps — what they do

| App | Where the aggregation happens | Daily-row pattern |
| --- | --- | --- |
| Apple Health.app | iOS uses `HKStatisticsCollectionQuery` with `intervalComponents: .day` + `options: .cumulativeSum` — the same on-device merge HK uses for sibling-source dedup. Per-sample rows are never user-visible at default zoom. | One per day |
| Withings Health Mate | Server-side `getactivity` returns one entry per calendar day per metric. No per-sample timeline. | One per day |
| Garmin Connect | Wearable streams raw per-minute counts to the phone, phone aggregates daily and pushes once per midnight roll-over. Per-minute "intensity" is queryable but the dashboard's "Steps" tile is daily-only. | One per day (+ optional intensity stream) |
| Oura Ring | Ring streams to phone; phone posts daily roll-ups to Oura cloud. Activity score is computed off the daily roll-up server-side. | One per day |
| MacroFactor | Polls Apple Health (or Google Fit) via `HKStatisticsCollectionQuery`; stores daily totals. No per-sample rows. | One per day |
| Whoop | Wearable bound to phone; phone pre-aggregates per-minute strain bands but exposes daily / sleep-period totals to server. | One per day |

**Universal pattern**: cumulative metrics are aggregated daily on the
client (where the cross-source merge knowledge lives) before they reach
the server. The exceptions (Garmin per-minute intensity, Whoop per-band
strain) are stored separately and never confused with the daily total.

### `HKStatisticsCollectionQuery` semantics (the right primitive)

```swift
let query = HKStatisticsCollectionQuery(
    quantityType: HKQuantityType(.stepCount),
    quantitySamplePredicate: nil,           // include every source
    options: .cumulativeSum,
    anchorDate: startOfDay,
    intervalComponents: DateComponents(day: 1)
)
```

Apple's merge algorithm (the same one Health.app uses) prefers
Apple Watch samples while the watch was on-wrist and falls back to
iPhone samples for unworn intervals. The cross-source double-count
disappears at the source. The query's `enumerateStatistics(from:to:)`
callback yields one `HKStatistics` per interval — `sumQuantity()` gives
the daily total.

Two contract points worth noting:

- The query is asynchronous and uses a separate `initialResultsHandler`
  + `statisticsUpdateHandler` pair — the latter fires whenever the
  underlying sample set changes for any day in the window. This is the
  natural "yesterday's steps just changed because the watch synced 2 h
  late" path.
- Apple charges the `HKStatisticsCollectionQuery` against a different
  rate budget than `HKAnchoredObjectQuery`. WWDC20 "Beyond counting
  steps" specifically recommends it for cumulative types and warns
  against re-implementing the merge logic client-side.

---

## 3. Three plausible shapes

### Option A — iOS pre-aggregates daily (RECOMMENDED)

iOS runs `HKStatisticsCollectionQuery` per cumulative metric. On an
observer wake-up, the handler asks "what's the new daily sum for the
affected days?" and POSTs one row per day per metric to
`/api/measurements/batch`.

- `externalId = "stats:HKQuantityTypeIdentifierStepCount:<YYYY-MM-DD>:<deviceType?>"`
  — deterministic per (type, day, optional device-type bucket). Posting
  yesterday's count again after a late watch sync naturally
  `duplicate`-collapses on the existing `(userId, type, source, externalId)`
  unique index.
- `measuredAt` = midnight UTC of the day (or 12:00 UTC noon to match
  Withings' `activityMeasuredAt()` convention — see §6 for the choice).
- `value` = `HKStatistics.sumQuantity().doubleValue(for: .count())`.
- `source = APPLE_HEALTH`, `deviceType = "watch"` when the user wears one
  (the query's `sources` array carries the contributing source revisions —
  pick the dominant one or "phone" as fallback).

### Option B — Server-side nightly roll-up

iOS keeps posting per-sample rows. Server runs a 03:00 cron that walks
yesterday's APPLE_HEALTH rows per cumulative type and writes one
`source = APPLE_HEALTH_DAILY` (new enum value) row per day with the
summed value. Raw rows can stay (for analytics) or be purged after N
days.

### Option C — Hybrid bucket key on the row

iOS posts per-sample rows + a `bucketKey` field on each row (date in
user TZ). Server stores the bucketKey. Reads aggregate by bucketKey at
query time via a `GROUP BY` view. No daily-roll-up cron.

---

## 4. Trade-off table

| Axis | A — iOS pre-aggregates | B — Server cron roll-up | C — Hybrid bucketKey |
| --- | --- | --- | --- |
| Storage cost | 5-200× lower (1 row vs 50-200 rows per day per metric) | Higher (raw + daily) unless raw purged; purging breaks analytical fidelity | Same as today (no row reduction) |
| Query cost on `/series?kind=steps` | `O(days)` (~30 rows) | `O(days)` after the cron runs, `O(samples)` before | Needs a `GROUP BY bucketKey` per read — `O(rows)` walked, `O(days)` returned |
| Dashboard sparkline latency | Best — fewest rows | Good after the cron, stale-ish today | Worst — GROUP BY on hot path |
| iOS battery / bundle | `HKStatisticsCollectionQuery` is documented as cheaper than reading every sample (Apple does the merge once internally) | Same as today | Same as today |
| Cross-source dedup (Watch + iPhone double-count) | Solved by HK's merge algorithm at the source | Server must replicate Apple's merge — fragile; can't see "watch on-wrist" signal | Server must replicate Apple's merge — same fragility |
| iOS contract | Additive — one new optional field shape via the existing batch entry. `externalId` syntax changes for cumulative types only. No new endpoint. | No iOS change. New `source` enum value `APPLE_HEALTH_DAILY` (additive in the Postgres enum). | One new optional field `bucketKey` in the batch entry. Existing rows stay valid. |
| Server schema impact | None | Either a new `source` enum value or a new boolean column `isDailyRollup`. Migration runs additive. | New nullable `bucket_key` column + an index. |
| Cron / worker code | None | New worker (with idempotency, backfill replay, race vs incoming new rows). Failure modes: cron lag, partial-day data, raw-row replay. | None |
| PR detection | Works as-is on daily rows | Two PR sources confuse the detector (raw row crosses + rollup row crosses) unless detector is taught to skip raw rows | Works as-is once GROUP BY view is honoured |
| Analytics fidelity | Hourly granularity lost — only daily totals stored. Acceptable per Apple's own UX (Health.app doesn't show step timelines beyond per-hour ring) | Both grains available; raw rows useful if anyone ever wants hourly | Hourly granularity preserved |
| Withings parity | Matches Withings' existing daily-row shape | Asymmetric (Withings = daily rows, APPLE_HEALTH = raw + daily) | Asymmetric (Withings unchanged, APPLE_HEALTH gets a bucketKey field Withings doesn't carry) |
| Migration for existing per-sample rows | Optional drain. iOS starts posting daily rows after upgrade; raw rows stay in DB and are read-side compatible via the existing canonical-source picker. Periodic compaction job can collapse them later. | Cron's first run writes the rollups for every back-filled day. Raw rows kept until a separate drain. | Backfill a `bucketKey` on existing rows (one-time UPDATE). |
| Forward generalisation to other continuous types | Same query primitive works for active energy, flights climbed, distance, time-in-daylight, audio exposure (mean instead of sum), basal energy, exercise minutes | Same cron pattern — yes, but every metric needs its own aggregation function lookup table on the server | bucketKey field generalises, but server still has to know which types are aggregatable |
| Race conditions | iOS owns the merge — only race is two iOS devices on the same Apple-ID posting the same day. `externalId` collapses both. | Cron vs incoming late writes for "today's" rollup — partial-day rollup fires, late sample drifts in, rollup is stale. Solvable but new complexity. | None new |
| Effort web | S (helper + schema doc + chart-aware aggregator fix) | M (worker, cron schedule, enum value, backfill replay) | M (column, index, backfill, GROUP BY in 4-5 read paths) |
| Effort iOS | M (HKStatisticsCollectionQuery wrapper + per-type config + observer wiring) | None | S (one new field on the wire entry) |

---

## 5. Recommendation — Option A, with one clarification

**Decision: Option A.** Three reasons it wins decisively:

1. **The merge logic must run on iOS**, full stop. Apple Watch
   on-wrist heuristics are not surfaced through any API the server can
   consume. Re-implementing them server-side (Option B or C) means
   re-implementing a moving target — Apple has tweaked the merge in
   four iOS versions per the WWDC archive. The deep-dive § 2 Layer 3
   explicitly says no server-side merge.
2. **Withings is already shaped this way.** The
   `pickCanonicalSourceRows` helper, the chart's `aggregate=daily`
   path, and the dashboard sparkline already expect "one row per day"
   for cumulative metrics from WITHINGS. Option A puts APPLE_HEALTH
   on the same shape — `pickCanonicalSourceRows` then just works,
   the AVG-vs-SUM bug in `route.ts:84` becomes irrelevant for steps
   (one row per day, AVG and SUM are identical), and the dashboard
   stops paying for a query that walks thousands of rows.
3. **Reversible without a schema break.** Option A is additive on
   both sides — old iOS builds that keep posting per-sample rows
   continue to work (raw rows land, `pickCanonicalSourceRows` sums
   them, the contract holds). New iOS builds post daily rows. The
   raw-row drain is a separate, optional compaction job that can run
   in v1.5.1 or later.

### The clarification — what about hourly granularity?

Some users will want to see a per-hour step breakdown ("when did I
walk yesterday?"). The honest answer is that Apple Health.app's main
"Steps" view doesn't show this either — it's a per-day bar chart.
The per-hour breakdown is one drill-in tap away and uses
`HKStatisticsCollectionQuery` with `intervalComponents: .hour`.
HealthLog can adopt the same pattern: store daily; for the rare
"hourly drill-in" UX, send a separate read-only query to HealthKit
without persisting hourly rows. v1.5 does not need this — the iOS app
shows the daily total + a 30-day sparkline, both served from the
daily-row stream.

### Edge case — late sample arrivals

When the watch syncs at 14:00 with samples from this morning, the
existing day's row should *update* on the server, not insert a second.
This is exactly what `externalId = "stats:<type>:<YYYY-MM-DD>"` plus
the `(userId, type, source, externalId)` unique index buys: the second
POST's per-entry status returns `duplicate`. To make the value update
visible, iOS needs to detect "the new statistics for an already-posted
day differ from what was sent" and issue a `PATCH /api/measurements/[id]`.

Two ways to handle this; pick one:

| Approach | Pro | Con |
| --- | --- | --- |
| iOS keeps last-posted-value per (type, day) and PATCHes when it diverges | Clean, one row per day always | Needs a PATCH path the iOS app doesn't use today (the route exists; iOS just doesn't call it for batch ingest) |
| Server upserts on `externalId` collision in the batch path (new behaviour) | iOS posts blindly; server resolves | Diverges from the current "duplicate-collapse, no update" contract; PR detection might double-fire |

**Recommend the first** — it keeps the batch ingest contract narrow
(insert-only) and the PATCH route already exists and is wired to its
own audit log. iOS-side latency: a single PATCH per affected day, at
most a handful per sync.

---

## 6. Implementation sketch

### Server (effort: S)

- `src/lib/measurements/apple-health-mapping.ts`
  - Document the daily-rollup `externalId` convention as the canonical
    shape for cumulative types. Add a string-constant helper
    `dailyStatsExternalId(typeIdentifier, dayISO)` that mints
    `"stats:<typeIdentifier>:<YYYY-MM-DD>"` and is round-trip-safe.
  - Add a `cumulativeTypes` set so future analytics can ask "is this
    aggregated daily on ingest?" (used by the AVG/SUM router in §6.2).
- `src/app/api/measurements/route.ts` — when `aggregate=daily` and the
  type is in `cumulativeTypes`, switch the SQL from `AVG(value)` to
  `SUM(value)`. Strictly speaking, with Option A producing one row per
  day, AVG and SUM are the same — but the bug should still be fixed for
  any pre-Option-A rows that survive in the DB.
- `src/app/api/measurements/series/route.ts` — same fix; today's path
  returns raw rows for `kind=steps` and the iOS app draws every dot.
  After Option A, this returns ~30 rows already (one per day from
  iOS), so the route is correct by accident. Belt-and-braces: do a
  `GROUP BY date_trunc('day', measured_at)` with SUM for cumulative
  types so legacy raw rows still aggregate cleanly during the cutover.
- `prisma/schema.prisma` — no change. The existing unique index does
  the dedup for free with the new `externalId` shape.
- `.planning/v15-ios-handoff/06-ios-responsibilities.md` — append a
  "Cumulative metrics: daily aggregation on iOS" section under
  Domain 1 with the exact `externalId` shape and the PATCH-on-divergence
  rule.
- `.planning/v15-ios-handoff/08-locked-contracts.md` — lock the
  `externalId` regex pattern for cumulative types so a future iOS
  build can't drift the shape silently.

### iOS (effort: M)

- New file `HealthLog/Services/HealthKitStatisticsService.swift`
  (or extension on `HealthKitService`) — wraps
  `HKStatisticsCollectionQuery` per cumulative type. Backfill window
  + ongoing observer wired through the existing `HKObserverQuery`
  trigger; the difference is the *response* — emit one
  `HealthKitBatchEntryDTO` per affected day instead of one per
  `HKQuantitySample`.
- `HealthLog/Services/HealthKitWireConverter.swift` — leave the
  per-sample path alone for spot metrics. For cumulative types, the
  new statistics service builds the DTO directly (it doesn't go
  through `quantityEntry`).
- `HealthLog/Repositories/MeasurementBatchUploader.swift` — same
  upload path. Add a fast-path PATCH for "I previously posted day X
  with value V1; new statistics say V2; emit a PATCH".
- Per-cumulative-type config in
  `HealthLog/Services/HealthKitService.swift` —
  `cumulativeMetrics: Set<HKQuantityTypeIdentifier>` = stepCount,
  activeEnergyBurned, flightsClimbed, distanceWalkingRunning,
  timeInDaylight (when iOS 17+). Each gets `.day` interval + matching
  HK unit.
- `HealthLog/Util/AppEnvironment.swift` — guard cumulative aggregation
  behind a build-flag for the first TestFlight build so the per-sample
  path stays available as a fallback during validation.

### iOS contract delta

Additive only. The batch entry shape stays exactly the same; only the
*contents* the iOS app sends change for cumulative types:

| Field | Spot metric (today) | Cumulative metric (Option A) |
| --- | --- | --- |
| `hkIdentifier` | `HKQuantityTypeIdentifierBodyMass` (e.g.) | `HKQuantityTypeIdentifierStepCount` (e.g.) |
| `value` | sample's raw value | `HKStatistics.sumQuantity()` for the day |
| `unit` | sample's HK unit | same canonical unit (`count`, `kcal`, `m`, `min`) |
| `startDate` | `sample.startDate` | day start in user TZ |
| `endDate` | `sample.endDate` | day end (or next-day start - 1ms) in user TZ |
| `externalId` | `sample.uuid.uuidString` | `"stats:<typeIdentifier>:<YYYY-MM-DD>"` |
| `deviceType` | `HKDevice.model` mapping | dominant source revision's device (watch \| phone), or `null` |

### Rollout path

1. **Server first** (no schema change): document the new `externalId`
   shape; fix the AVG → SUM router for cumulative types; ship.
2. **iOS opt-in build** behind a `ENABLE_DAILY_STATS` flag for a
   TestFlight beta. Run side-by-side against the per-sample path so
   the maintainer can sanity-check daily totals against Apple
   Health.app.
3. **Cut over** the iOS build to daily-stats-by-default. Old iOS
   builds continue to post per-sample; the read-side aggregator
   keeps both shapes correct.
4. **Compaction** (v1.5.1 or later, optional): one-time script
   collapses per-sample APPLE_HEALTH cumulative rows into daily rows
   keyed by the new `externalId` shape. Idempotent — re-running is a
   no-op. Tracked as a back-burner item; not required for the v1.5
   release.

### Generalisation to other continuous types

| HK type | Aggregation | Server enum today | Notes |
| --- | --- | --- | --- |
| `stepCount` | sum | `ACTIVITY_STEPS` | The canonical case. |
| `activeEnergyBurned` | sum | `ACTIVE_ENERGY_BURNED` | Same pattern; one row per day. |
| `flightsClimbed` | sum | `FLIGHTS_CLIMBED` | Same. |
| `distanceWalkingRunning` | sum | `WALKING_RUNNING_DISTANCE` | Same. |
| `timeInDaylight` (iOS 17+) | sum | `TIME_IN_DAYLIGHT` | Same; one sample-per-minute roll-up. |
| `environmentalAudioExposure` | mean | `AUDIO_EXPOSURE_ENV` | `HKStatisticsCollectionQuery` with `options: .discreteAverage` instead of `.cumulativeSum`. |
| `headphoneAudioExposure` | mean | `AUDIO_EXPOSURE_HEADPHONE` | Same as env. |
| `appleExerciseTime` (deferred) | sum | — | Future. |

Spot metrics — weight, body fat, BP, pulse, blood glucose, body
temperature, oxygen saturation, HRV, resting HR, VO2 max, skin
temperature — all stay per-sample. They are point-in-time
observations; aggregating to "the day's average BP" loses clinical
fidelity. The deep-dive § 2 Layer 2 already argues this.

Sleep stays a special case — per-stage rows for one night, anchored
by the v1.4.25 W17b 5-axis unique index. Not in scope for this
research.

### Why not Option B in one sentence

It re-implements Apple's cross-source merge on the server with strictly
worse inputs and adds a new failure mode (cron lag) that the customer
will see as "today's steps are wrong until 03:00 tomorrow".

### Why not Option C in one sentence

It keeps the per-sample row volume (no storage win), pays for a
GROUP BY on every chart read, and still doesn't solve the
Watch + iPhone double-count problem — the bucketKey collapses sibling
rows by *day*, not by *moment*, so the watch and iPhone both post
non-deduped samples for the same minute.

---

## 7. Risks + open questions

| Risk | Mitigation |
| --- | --- |
| Late watch sync writes a divergent value for an already-posted day | iOS keeps a small SQLite cache of `(type, day, last-posted-value)`; on next observer wakeup, diff against the new `HKStatistics.sumQuantity()` and PATCH if changed. |
| User changes timezone — day boundaries shift mid-stream | Anchor the day key in **user-server-timezone** (from `User.timezone`) — same convention `MoodEntry.tz` introduced in v1.4.25 W7b. iOS reads the user's timezone from `/api/auth/me` and pins it for the duration of the session. |
| PR detection over-fires on the daily roll-up replacing yesterday's value | PR detector compares against the historical best; a late-sync update from 9500 to 10100 steps still triggers a legitimate PR. Acceptable. |
| Pre-Option-A rows + post-Option-A rows for the same day land in the DB | `pickCanonicalSourceRows` already sums same-day same-source rows. Per-sample rows + a daily-rollup row sum together and double-count — the cutover window needs an upper bound. Either drain raw rows before flipping the iOS build's `ENABLE_DAILY_STATS` to ON by default, or have the iOS migration write a one-time "delete my raw cumulative rows for this account" call against `DELETE /api/measurements/by-external-ids`. Recommend the latter — it's already in the iOS toolkit. |
| `HKStatisticsCollectionQuery` doesn't surface deleted samples the same way `HKAnchoredObjectQuery` does | The deep-dive § 3 already addresses HK deletion via the 30-day window reconciliation on `DELETE /api/measurements/by-external-ids`. For cumulative rows the reconciliation must compare *day-keyed* externalIds against HK's current 30-day daily sums — one row per day, easier than the spot-sample case. |

---

## 8. Files touched (server, server-side change set)

| Path | Change |
| --- | --- |
| `src/lib/measurements/apple-health-mapping.ts` | Add `dailyStatsExternalId()` helper + `CUMULATIVE_HK_TYPES` set. |
| `src/app/api/measurements/route.ts` | Switch `aggregate=daily` SQL from AVG to SUM for cumulative types (covered by the new set). |
| `src/app/api/measurements/series/route.ts` | Group-by-day SUM for cumulative `kind`s (steps + future cumulative additions). |
| `.planning/v15-ios-handoff/06-ios-responsibilities.md` | Document daily-aggregation contract for cumulative types under Domain 1. |
| `.planning/v15-ios-handoff/08-locked-contracts.md` | Lock the `externalId` shape `"stats:<typeIdentifier>:<YYYY-MM-DD>"`. |
| `src/lib/analytics/source-priority.ts` (no change) | Already sums per-day per-source — works correctly with Option A by accident. |
| `prisma/schema.prisma` (no change) | The existing 5-axis + 4-axis unique indexes already enforce the right dedup behaviour for daily rows. |

## 9. Files touched (iOS, sketch)

| Path | Change |
| --- | --- |
| `HealthLog/Services/HealthKitStatisticsService.swift` (new) | `HKStatisticsCollectionQuery` wrapper per cumulative type. |
| `HealthLog/Services/HealthKitWireConverter.swift` | Skip cumulative types in `quantityEntry`; statistics service builds those DTOs. |
| `HealthLog/Services/HealthKitService.swift` | Wire the statistics service into the per-type observer wakeup. Track per-day last-posted-value cache. |
| `HealthLog/Repositories/MeasurementBatchUploader.swift` | Add PATCH-on-divergence path for daily-rollup rows. |
| `HealthLog/Models/HealthKitBatchDTO.swift` (no change) | DTO shape unchanged. |
| `HealthLog/Util/AppEnvironment.swift` | Add `ENABLE_DAILY_STATS` build flag (default OFF for the first build, ON for the cut-over build). |

---

## 10. Six-line summary

- **Chosen option**: A — iOS pre-aggregates daily via `HKStatisticsCollectionQuery`.
- **Rationale headline**: Apple's cross-source merge must run on-device (server can't see watch-on-wrist state); Withings already lands daily rows, so Option A puts APPLE_HEALTH on parity instead of staying the odd one out.
- **iOS contract impact**: Additive — same `HealthKitBatchEntryDTO` shape; only the `externalId` *convention* changes for cumulative types (`"stats:<typeIdentifier>:<YYYY-MM-DD>"`), and a new `PATCH` path is exercised when late watch syncs revise yesterday's total.
- **Generalisation to other continuous types**: Yes — same primitive covers active energy, flights climbed, walking-running distance, time-in-daylight (sum), and audio-exposure metrics (mean). Spot metrics (weight, BP, BG, HRV…) stay per-sample.
- **Top risk**: Cutover window when pre-Option-A per-sample rows coexist with post-Option-A daily rows for the same day — `pickCanonicalSourceRows` will sum both shapes and double-count. Mitigate by draining raw cumulative rows via `DELETE /api/measurements/by-external-ids` on the iOS migration's first run.
- **Effort**: web S (helper + AVG-to-SUM router + handoff doc updates), iOS M (statistics service + per-day cache + PATCH-on-divergence wiring + per-cumulative-type config).
