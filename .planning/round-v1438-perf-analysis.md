# v1.4.38 — perf analysis: heavy-query inventory + rollup gap map

Read-only audit of every heavy `/api/*` read path on Marc's 347 114-row
tenant. Anchors on the Coolify production log excerpts from the
v1.4.38.7 verify run and the existing rollup tier
(`src/lib/measurements/rollups.ts`,
`src/lib/measurements/rollup-coverage.ts`,
`src/lib/measurements/rollup-read.ts`).

Numbers below are wall-clock observed on the live tenant; row counts
are estimates derived from the live `row_count: 347114, type_count: 15`
annotate plus the per-endpoint window cuts.

---

## 1 — Heavy-query inventory

### `/api/analytics` (slim slice — `?slice=summaries`)

Wrapped by `cached(caches.analytics, "${userId}|summaries", …)`
(`src/app/api/analytics/route.ts:62-78`). 60 s TTL. Cold call drops
into `computeSummariesSlice(userId)`
(`src/lib/analytics/summaries-slice.ts:562`).

| # | Call | Source | Est. rows | Live time |
|---|---|---|---|---|
| S1 | `prisma.measurement.findMany` (90-day window per type) — line 308 of summaries-slice (referenced via grep) | live SQL | ~thousands per type × 15 | bundled into the 3.5 s cold |
| S2 | `prisma.measurementRollup.findMany` 90-day DAY buckets — `summaries-slice.ts:309` | rollup DAY | ~90 × N | warm |

Cold: **3.5 s** (Coolify: `row_count:347114 type_count:15 path:"live"`).
Warm cache hit: < 50 ms.

Why slow on cold: the slice's narrow `$queryRaw` aggregate still walks
the raw `measurements` table for `slope/r2/sd` because those columns
don't compose linearly from DAY buckets.

### `/api/analytics` (full slice — default)

`buildAnalyticsResponse(user)` — `route.ts:161-504`. Wrapped in
`caches.analytics` (line 86-91, 60 s).

Per-branch reads on cold fan-out (Marc's prod log shows the full slice
at **74.6 s** cold with all three big sub-paths annotating `path:"live"`):

| # | Call | Where | Source | Est. rows | Notes |
|---|---|---|---|---|---|
| A0 | `ensureUserRollupsFresh(user.id)` (fire-and-forget) | `route.ts:173` | — | — | non-blocking |
| A1 | `probeRollupCoverage(user.id)` | `route.ts:182` | live `$queryRaw` over `measurements` LEFT JOIN `measurement_rollups` | ~15 rows | cheap, indexed |
| A2 | `fetchMeasurementSeriesChunked` per-type **× 15** | `route.ts:224-310` (`fetchMeasurementSeriesChunked` 634-681) | live `measurements.findMany` paged 5 000 | **~347 114 total** | dominates cold path |
| A3 | `computeSleepStageBreakdown` → `measurement.findMany({type:SLEEP_DURATION, sleepStage:{not:null}, gte:-30d})` | `route.ts:532` | live | hundreds | OK |
| A4 | glucose 30-day `findMany` | `route.ts:424` | live | small | OK |
| A5 | `computeBpInTargetFastPath` × 2 (now, now-7d) | `route.ts:388-408` | rollup DAY (when covered) / chunked findMany fallback | 2 × `readRollupBuckets` | OK on rollup, hot on live |
| A6 | `computeUserHealthScoreFastPath` | `route.ts:472` | mixed (rollup DAY for weight + live for BP-source + mood + medications + intake) | see §3 | bursts of 4 parallel findMany |
| A7 | `computeCorrelationHypothesesFastPath` | `route.ts:454` | rollup DAY for SYS+PULSE+WEIGHT (when covered) + live for mood + intake | 28-day window | OK on rollup |

**Root cause of the 74.6 s cold**: A2 — the per-type loop reads
**every measurement ever** for the user via
`fetchMeasurementSeriesChunked` (no `since` filter for the default
slice). With 347 k rows fanned out across 15 types this is **~70
chunked round-trips at 5 000 rows each**. Even on a hot pool that's
40-60 s pure Prisma RT cost.

Also: the three fast-path helpers (A5/A6/A7) report `path:"live"` in
the Coolify log even though `ensureUserRollupsFresh` should have
warmed the DAY tier. See §4 for why the `isFullyCovered` gate keeps
flipping false.

### `/api/insights/comprehensive`

`buildComprehensiveAggregate` — `src/lib/insights/comprehensive-aggregator.ts`.

| # | Call | Source | Notes |
|---|---|---|---|
| C1 | narrow windowed `$queryRaw` aggregate (90-day, `window_stats` CTE + `GROUP BY type`) | live | not composable from DAY buckets; canonical |
| C2 | `$queryRaw DISTINCT ON (type)` latests | live | cheap |
| C3 | `prisma.measurementRollup.findMany` 90-day DAY buckets — `comprehensive-aggregator.ts:435` | rollup | reused by composed-summary branch |
| C4 | `measurement.findMany({type:{in:[BP_SYS,BP_DIA]}})` consolidated — `:308` | live | bounded ~2 × 90-day |
| C5 | `$queryRaw SELECT MIN(measured_at)` firstAt | live | indexed |

Cold: ~3.1 s (W-F report). Wrapped in 60 s LRU.

### `GET /api/dashboard/summary`

Rewritten in W-F. Already on `measurement_rollups` DAY (B2 sparkline),
`DISTINCT ON` 7-day window (B1), `groupBy` per type (B3), `$queryRaw
DISTINCT to_char(... AT TIME ZONE $tz)` streak (B6). Plus
`caches.analytics` `${userId}|dashboard-summary` 60 s wrap. Cold target
**~500 ms**, warm < 50 ms.

### `GET /api/mood/analytics`

`src/app/api/mood/analytics/route.ts:39`:

```ts
const moodEntries = await prisma.moodEntry.findMany({
  where: { userId },
  orderBy: { moodLoggedAt: "asc" },
  select: { date: true, score: true, moodLoggedAt: true },
});
```

**Unbounded findMany over the user's entire `MoodEntry` table.** Then
`aggregateDailyAverages` + `summarize` (with slope7/slope30/slope90)
runs in JS. Coolify cold: **12.7 s `path:"live"`**. Wrapped in
`caches.moodAnalytics` (60 s LRU).

Why slow: every mood entry the user ever wrote is pulled into Node and
re-bucketed in JS. No rollup tier for mood at all. For Marc that's
hundreds of rows (mood is daily) — the slowness comes from
`summarize()` running slope3-windows over the full series, not the row
count. The 12.7 s smells like a connection-pool stall on cold mount
rather than CPU.

### `GET /api/medications/intake?scope=compliance&days=N`

`src/app/api/medications/intake/route.ts:154`:

```ts
const events = await prisma.medicationIntakeEvent.findMany({
  where: { userId, scheduledFor: { gte: start } },
  select: { scheduledFor: true, takenAt: true, skipped: true },
});
```

Then per-day bucketing in JS. Wrapped in `caches.medicationsIntake` 15
min LRU keyed `${userId}|compliance|${days}|${userTz}`. Coolify cold:
**3.2 s**.

Bounded read — `gte: now - days * 86_400_000` — so the row count is
`activeMedSchedules × days` (typically a few hundred). The 3.2 s is
again pool stall, not row count. No rollup tier for medication
compliance.

### `GET /api/medications/intake?scope=today`

`route.ts:81` — bounded `findMany` on today's window with `include:
{medication}`. Coolify Marc: **3.5 s** on `/api/medications`. Small row
count. Cold-pool stall.

### `GET /api/measurements?groupBy=day`

`src/app/api/measurements/route.ts` — grep shows:

- line 96 `prisma.measurement.findMany({…samples})` (downsampled per type)
- line 132 the `groupBy=day` branch `prisma.measurement.findMany`
- line 274 `prisma.measurementRollup.findMany` (rollup tier IS consumed
  here on the `groupBy=day` path — good)
- line 396 a fall-through `findMany`

Coolify shows healthy ≤ 1 s on this endpoint per recent verify
captures. Not a current hotspot.

### `GET /api/workouts`

Coolify: **0.31 s**. Not a hotspot.

---

## 2 — Rollup table inventory

### Granularities defined

`MeasurementRollup.granularity` is `RollupGranularity` enum =
`DAY | WEEK | MONTH | YEAR` (`prisma/schema.prisma:513-532`,
`rollups.ts:40-45`).

Composite key:
`@@id([userId, type, granularity, bucketStart])` plus the descending
index `@@index([userId, type, granularity, bucketStart(sort: Desc)])`.

### What populates each granularity

| Granularity | Per-write hook (sync) | `recomputeUserRollups` (worker / boot) | `ensureUserRollupsFresh` (read warm-up) |
|---|---|---|---|
| DAY | YES — `recomputeBucketsForMeasurement` runs DAY inline (`rollups.ts:172-197`) | YES — default `granularities` | YES — **DAY only**, 90-day window (`rollups.ts:673-677`) |
| WEEK | NO — enqueued to pg-boss `rollup-recompute` queue (`rollups.ts:209-220`) | YES — default `granularities` | NO |
| MONTH | NO — enqueued (same) | YES | NO |
| YEAR | NO — enqueued (same) | YES | NO |

The boot-time backfill `enqueueBootTimeRollupBackfill` (`rollups.ts:723`)
discovers users missing **DAY** coverage per type (`r."granularity" =
'DAY'`) and enqueues a full `recomputeUserRollups(userId)` with
default opts → that single full-fold writes all four granularities once
per uncovered user.

### Which granularities the READ paths consult

| Reader | Granularity it reads | Window |
|---|---|---|
| `bp-in-target-fast-path.ts:199-214` | **DAY** | trailing ~395 days |
| `correlations-fast-path.ts:173-177` | **DAY** | trailing 28 days |
| `health-score-fast-path.ts:166-172` | **DAY** | 37-day window |
| `comprehensive-aggregator.ts:435` | **DAY** | 90-day window |
| `summaries-slice.ts:309` | **DAY** | 90-day window |
| `/api/dashboard/summary` (W-F) | **DAY** | 7-day window |
| `/api/measurements?groupBy=day` | **DAY** | per request range |
| `ensureUserRollupsFresh` | **DAY** | 90-day warm-up |
| `isRollupFresh` | per call — caller passes granularity | — |

### Critical gap

**No read path consumes WEEK / MONTH / YEAR buckets.** Marc's tenant
has a worker writing them every measurement (via the pg-boss queue) +
on the boot backfill, and `ensureUserRollupsFresh` actively avoids
recomputing them. They sit as dead weight that costs DB rows + write
amplification but produces zero read-side wins.

This is the largest single architectural gap: the rollup table's
multi-granularity design is unused on read. Every analytics window
> 90 days could be served from MONTH or YEAR buckets instead of
falling through to live SQL.

---

## 3 — Aggregations re-derived on every request that the rollup
       table could pre-compute

### Mood daily aggregates — **no rollup at all**

`/api/mood/analytics` (`route.ts:39`) does an unbounded findMany over
`MoodEntry` and bucket-averages in JS. The rollup table is keyed on
`MeasurementType` (Postgres enum) → it has no slot for mood.

**Proposed table**: `mood_rollups (user_id, granularity, bucket_start,
count, mean, sd)` with write-hooks fired from any `MoodEntry`
create/update/delete. Read path: `aggregateDailyAverages` swaps to
`prisma.moodRollup.findMany` directly. Expected: 12.7 s → ~200 ms cold.

### Medication intake / compliance — **no rollup at all**

`/api/medications/intake?scope=compliance` (`route.ts:154`) reads every
intake event in the window. Worker-driven compliance aggregator could
maintain a `medication_compliance_rollups (user_id, medication_id,
day, scheduled, taken)` row keyed on Berlin day. Write-hook fires
from POST `/api/medications/intake` plus the scheduler that creates
events.

Read path: `buildComplianceBuckets` becomes a single bounded findMany.
Expected: 3.2 s → ~200 ms cold (mostly elimination of pool stall).

Also benefits `computeUserHealthScoreFastPath` (lines 263-303 today
issue an active-meds findMany + per-med intake event findMany).

### Workout daily / weekly counts

Not currently slow (0.31 s) so deferral is safe. If iOS Apple Health
import lands a higher workout volume, a `workout_rollups
(user_id, sport_type, day, count, total_kcal, total_distance_m,
total_duration_sec)` would future-proof the workouts hot path.

### Cumulative daily sums (steps / flights / distance / energy)

`pickCumulativeDaySum` in `route.ts:262-295` does the per-day-sum
collapse **in JS** after pulling the full per-type chunked series.
The DAY rollup's `mean` × `count` is exactly the sum the helper would
produce when `source_priority` collapses to a single source.

Add a derived `sumValue` column on `MeasurementRollup` (or compute it
on read as `mean * count`) and route cumulative metrics through the
rollup tier. Saves the entire A2 chunked walk for `ACTIVITY_STEPS`,
`ACTIVE_ENERGY`, `WALKING_RUNNING_DISTANCE`, `FLIGHTS_CLIMBED`,
`TIME_IN_DAYLIGHT`. Those five types are the ones with thousands of
rows per day on Marc's tenant (HealthKit minute-slices) and dominate
the 347 k row count.

Caveat: source-priority resolution per day breaks the simple
`mean*count` shortcut when multiple sources contribute. Workaround:
maintain rollups **per (user, type, source, day)** and let the read
path pick the canonical source row.

### Per-type-source rollup (W8c canonical source)

Today `pickCanonicalSourceRows` runs per-day per-type in JS
(`route.ts:286-291`). A `(user_id, type, source, day)` rollup column
or table would let the read path query "give me the canonical source's
mean for this type for this day" directly.

### Time-zone day-keys

Rollup table buckets on **UTC midnight** (`startOfUtcDay`,
`rollups.ts:175, 514-518`; SQL `date_trunc('day', m."measured_at")`,
`rollups.ts:368`). Read paths re-key into `userTz` via `userDayKey`.

For Berlin (UTC+1/+2) the slip is < 1 calendar day at the boundary
which the `n>=20` surface gate absorbs. Marc's tenant is fine.

Bigger threat: v1.5 multi-tenant. The current cross-tz guard
(`isNearUtc`, ±3 h) force-routes non-near-UTC tenants to live SQL —
i.e. they get zero rollup benefit. A v1.5 follow-up should mint
per-user-tz buckets (or denormalize a `dayKey TEXT` column populated
via `to_char(measured_at AT TIME ZONE user.tz, 'YYYY-MM-DD')`).

---

## 4 — Read-path failures (rollup exists, read still falls to live)

### `isFullyCovered(coverage)` returns false

`rollup-coverage.ts:90-96`:

```ts
export function isFullyCovered(coverage: RollupCoverageMap): boolean {
  if (coverage.size === 0) return false;
  for (const hasBuckets of coverage.values()) {
    if (!hasBuckets) return false;
  }
  return true;
}
```

It flips false when **any single MeasurementType the user has logged
lacks DAY-bucket coverage**. With 15 measurement types on Marc's
account, one stray brand-new type (e.g. `TIME_IN_DAYLIGHT` arriving
from a new iOS sample without the corresponding rollup having been
written yet) is enough to force every downstream branch
(`bp_in_target`, `healthScore`, `correlations`) to `path:"live"`.

The v1.4.38.5 widening of `enqueueBootTimeRollupBackfill` discovery
query (`rollups.ts:744-755`) was meant to fix exactly this by
detecting per-type missing coverage, but the Coolify log shows
`path:"live"` is still firing on the full slice → the backfill hasn't
caught up or the per-write hook is failing for some type.

**Diagnostic gap**: `probeRollupCoverage` returns a map but the route
never annotates which types are uncovered. Add
`meta.coverage.missing: typesMissingCoverage(coverage)` to make this
visible in prod logs without redeploying instrumentation.

### `isNearUtc` cross-tz guard

`bp-in-target-fast-path.ts:147` + `correlations-fast-path.ts:141`.
For Berlin (`userTz = "Europe/Berlin"`) this returns **true** year-
round so the guard is a no-op for Marc. Confirmed safe.

Future risk: any tenant > ±3 h from UTC is forced to live SQL
permanently until the per-user-tz bucket migration lands.

### Health-score `weightCovered` gate

`health-score-fast-path.ts:149-150`:

```ts
const weightCovered =
  isFullyCovered(coverage) && coverage.get("WEIGHT") === true;
```

Same `isFullyCovered` dependency — one missing type ⇒ entire weight
pillar falls to live `measurement.findMany` (line 202-210).

### Correlations `measurementsOnRollups` gate

`correlations-fast-path.ts:148-153`:

```ts
const measurementsOnRollups =
  userNearUtc &&
  isFullyCovered(coverage) &&
  coverage.get("BLOOD_PRESSURE_SYS") === true &&
  coverage.get("PULSE") === true &&
  coverage.get("WEIGHT") === true;
```

Same issue + a `PULSE` coverage requirement. On Marc's account pulse
rollups are written but if a single non-needed type
(e.g. `BLOOD_OXYGEN` from Apple Watch) lacks coverage, this whole
branch still flips live.

**Architectural smell**: the three fast-path helpers gate on
`isFullyCovered(ALL_TYPES)` even though each one only needs a small
subset (BP, weight, SYS+PULSE+WEIGHT). The "full" requirement is
defensive overkill — a per-helper "needs these specific types covered"
predicate would let them ride the rollup independently.

### `ensureUserRollupsFresh` is fire-and-forget

`route.ts:173`:

```ts
void ensureUserRollupsFresh(user.id);
```

The first cold mount that triggers a stale rollup pays the **next**
request's cost — but the current request still hits `path:"live"`.
This explains the 74.6 s cold: it's the **first** request after a
warmth-loss event. Subsequent requests within 60 s hit the wrapper
cache; requests after 60 s find the DAY tier warm (assuming the
fire-and-forget completed).

Trade-off documented in the comment (lines 162-172) — necessary to
avoid stalling the Node event loop. The fix is to make the cold path
cheaper, not to await the warm-up.

---

## 5 — Proposed plan, ranked by impact / effort

### P0 — Diagnostic instrumentation (XS effort, gates the rest)

**Change**: annotate `meta.coverage.missing` on every fast-path so the
next perf-verify can prove WHICH type forces `isFullyCovered` false.

- Files: `correlations-fast-path.ts`, `bp-in-target-fast-path.ts`,
  `health-score-fast-path.ts`, `route.ts` (analytics).
- Helper: `typesMissingCoverage(coverage)` already exists
  (`rollup-coverage.ts:77`).
- Dev: ~30 min. Risk: none (additive annotate).
- **v1.4.38.x hotfix candidate.**

### P1 — Relax `isFullyCovered` to per-helper "needs these types" gate (S, high impact)

Replace the three call sites in §4 with explicit "these specific
types covered" predicates. One uncovered orphan type (e.g.
`BLOOD_OXYGEN`) no longer poisons BP / correlations / health-score
which don't read it.

- Files: as above.
- Dev: ~2 h. Risk: low (purely loosens the gate; covered types still
  ride the same path).
- **v1.4.39 candidate.** Could save the full 74.6 s cold if it turns
  out the gate is the actual culprit (verify with P0 first).

### P2 — Mood rollup (`mood_rollups`) (M, big localised win)

New `MoodRollup` table + write-hook on `MoodEntry`
create/update/delete + read-path swap in `/api/mood/analytics`.

- Files: `prisma/schema.prisma`, new
  `src/lib/mood/rollups.ts`, new worker queue, new write-hooks in
  every mood mutation site, `src/app/api/mood/analytics/route.ts`.
- Dev: ~1 day (the rollup pattern is well-trodden; mirrors
  `measurement-rollups`). Migration is additive.
- Expected: 12.7 s → ~200 ms cold. Warm hit unchanged.
- **v1.4.39 candidate.**

### P3 — Cumulative-metric sum column on `MeasurementRollup` (S, big A2 win)

Add `sumValue Float` column (or compute `mean * count` on read for
single-source case). Route cumulative types through rollup-derived
sums; eliminate the per-type chunked findMany for
`ACTIVITY_STEPS / ACTIVE_ENERGY / WALKING_RUNNING_DISTANCE /
FLIGHTS_CLIMBED / TIME_IN_DAYLIGHT`.

- Files: `prisma/schema.prisma` (additive column),
  `src/lib/measurements/rollups.ts` (writer adds sum),
  `src/app/api/analytics/route.ts` (skip A2 for cumulative types).
- Dev: ~half day. Migration additive (NULLable column populated by
  backfill).
- Expected: the per-type loop A2 drops from 15 reads × thousands of
  rows to 10 raw-type reads + 5 rollup-derived sums. Saves an
  estimated 20-40 s on Marc's cold full-slice (single biggest win
  next to P1).
- **v1.4.39 candidate.**

### P4 — Medication compliance rollup (M, kills the 3.2 s + helps health-score)

New `medication_compliance_rollups (user_id, medication_id, day,
scheduled, taken)`. Write-hook on intake-event mutations + the
scheduler that creates events.

- Dev: ~1 day. Migration additive.
- Helps `/api/medications/intake?scope=compliance` AND the heavy
  compliance loop inside `computeUserHealthScoreFastPath`
  (`health-score-fast-path.ts:267-303`).
- **v1.4.39 candidate.**

### P5 — Per-source rollup `(user, type, source, day)` (L, unlocks all
       cumulative types regardless of source mix)

Required if Marc's iOS-passthrough collides with a non-canonical
source (HealthKit forwarding Withings). Without it, the cumulative
shortcut in P3 only works when one source dominates.

- Dev: 2-3 days. Migration is a new table + write-hooks per source.
- **v1.5 architectural change.**

### P6 — Read paths for WEEK / MONTH / YEAR (M, future-proof)

Today's read paths cap at 90 days. The Coach drawer + the upcoming
"history" tile will want multi-year trends. Add reader helpers in
`rollup-read.ts` that aggregate from WEEK/MONTH/YEAR (linearly
composable for count/min/max/mean).

- Dev: ~1 day plus per-consumer wiring.
- **v1.4.40 / v1.5 candidate** (no current consumer, but the buckets
  are already populated so the tier is wasted otherwise).

### P7 — Per-user-tz bucketing (L, multi-tenant unlock)

Add a denormalised `dayKey TEXT` column populated via
`to_char(measured_at AT TIME ZONE user.tz, 'YYYY-MM-DD')`. Removes
the `isNearUtc` guard, lets the rollup path serve every timezone.

- Dev: ~2 days. Migration breaking-ish (column + backfill + index).
- **v1.5 architectural change.**

### P8 — `summarize()` slope-window compute move into Postgres

`summarize()` runs slope7/slope30/slope90 over the full series in JS.
The DAY rollup already carries `slope` per bucket — for the 7-day
slope, sum the last 7 buckets' contribution via a windowed
`REGR_SLOPE` in SQL instead of pulling the rows.

- Dev: ~1 day. Risk: medium (parity with existing JS math).
- **v1.5 candidate.**

---

## 6 — Quick-win bundle (< 1 day total)

Single hotfix bundle for v1.4.38.8 or v1.4.39.0:

1. **P0 diagnostic annotate** (~30 min). Surface
   `meta.coverage.missing` on every fast-path. Lets the next
   perf-verify prove the actual culprit on Marc's account before
   any architectural change.

2. **P1 per-helper coverage gate** (~2 h). Replace
   `isFullyCovered(coverage) && coverage.get("X")` with
   `coverage.get("X") === true` (and the same for each required type
   in correlations). If the §4 diagnosis is right, the 74.6 s cold
   collapses to ~3-5 s without any new tables.

3. **P3 cumulative-metric `sumValue`** (~half day). Additive column +
   reader-side branch. Eliminates 5 of the 15 chunked reads in A2
   (the 5 highest-row-count types on Marc's tenant). Saves an
   estimated additional 20-40 s on the cold-pool path.

Combined: 74.6 s → < 5 s on Marc's full-slice cold mount. Pure
additive changes; no migration risk.

---

## Brief-back (≤200 words)

**Top 3 findings**:

1. The 74.6 s full-slice cold on `/api/analytics` is driven by
   `fetchMeasurementSeriesChunked` running **per type × 15** with **no
   window filter** (`route.ts:224-310`). It pulls all 347 k rows from
   `measurements` even though the helpers downstream only need
   per-day means already living in the rollup table.

2. `isFullyCovered(coverage)` poisons the three fast-paths
   (`bp_in_target`, `correlations`, `healthScore`): one orphan
   uncovered type forces every helper to `path:"live"`, regardless of
   whether that helper actually reads the orphan. v1.4.38.5 widened
   the boot backfill discovery but the gate's all-or-nothing semantics
   stayed.

3. Mood and medication compliance have **zero rollup coverage** —
   every request re-derives them from raw findMany walks (12.7 s and
   3.2 s respectively on cold). WEEK / MONTH / YEAR buckets are
   populated by the worker but **no read path consults them** — dead
   write amplification.

**Top 3 quick-wins (< 1 day total)**: P0 missing-coverage annotate,
P1 per-helper "needs these types" gate, P3 cumulative-metric
`sumValue` column. Combined: 74.6 s → < 5 s on Marc's cold full-slice.

**v1.5 architectural recommendation**: per-user-tz bucketing
(P7) + per-source rollup (P5) + mood/medication rollups (P2+P4) +
WEEK/MONTH/YEAR readers (P6). Two-week sprint, unblocks every
non-Berlin tenant and finally puts the existing multi-granularity
write tier to work.
