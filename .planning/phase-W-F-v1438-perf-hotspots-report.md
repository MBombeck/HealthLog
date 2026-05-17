# v1.4.38 W-F — perf-hotspot fix-up

Two endpoints surfaced as 3-5 s cold during v1.4.37.x verification. Same
shape as the v1.4.37.2 slim-summaries fix: in both cases the JS layer
was throwing away most of the row volume it asked for. Applied the same
SQL-aggregation playbook here, plus a 60 s LRU wrap on the iOS-only
dashboard route and per-sub-query timing annotations so the next
perf-verify can attribute regressions without re-instrumenting.

## Endpoint A — `GET /api/dashboard/summary`

### Before

Four sub-queries inside the `Promise.all`, plus a fifth conditional
after it:

| # | Query | Row count on a power-user account |
|---|-------|-----------------------------------|
| A1 | `measurement.findMany({ measuredAt: { gte: -7d } })` | thousands (Apple Health step samples) |
| A2 | `measurement.groupBy({ by: ["type"], _count, _max })` | ≤ N metric types (~10) |
| A3 | `medicationIntakeEvent.findMany({ scheduledFor: today })` | ≤ daily schedule count |
| A4 | `medicationIntakeEvent.findMany({ scheduledFor: { gte: -365d } })` | hundreds |
| A5 (conditional) | `measurement.findMany({ measuredAt: { gte: -365d } })` | up to **tens of thousands** of raw rows |

Wall-clock: ~4.6 s cold mount per Marc's HAR capture. A1 and A5 were
dominant on power-user accounts.

### After

Six bounded sub-queries; the conditional fifth is folded back into the
Promise.all:

| # | Query | Bounded row count |
|---|-------|-------------------|
| B1 | `$queryRaw DISTINCT ON (type)` over 7d window | one row per metric type |
| B2 | `$queryRaw` over `measurement_rollups` DAY buckets in 7d | ≤ `SPARK_DAYS × N` ≈ 70 |
| B3 | `measurement.groupBy({ by: ["type"], _count, _max })` | unchanged |
| B4 | `medicationIntakeEvent.findMany({ scheduledFor: today })` | unchanged |
| B5 | `medicationIntakeEvent.findMany({ scheduledFor: { gte: -365d } })` | unchanged |
| B6 | `$queryRaw SELECT DISTINCT to_char(measured_at AT TIME ZONE $tz, 'YYYY-MM-DD')` | ≤ 365 |

Then wrap the whole response in `caches.analytics` keyed
`${userId}|dashboard-summary` with a 60 s TTL. The cache hit path skips
the whole builder.

Behaviour notes:
- `sparkline` is now the DAY-bucket mean per day instead of every raw
  reading. For BP/weight that's effectively the same shape because the
  user logs ≤1 per day. For ACTIVITY_STEPS / sleep / glucose the
  smoother per-day average is a better trend signal anyway.
- `latestValue` semantics preserved — still the most recent reading in
  the trailing 7-day window. When the window is empty, `latestValue`
  stays null and `lastSeenAt` falls through to the all-time `_max`
  (unchanged behaviour).
- The `AT TIME ZONE $tz` conversion is done server-side so the day-key
  set is byte-identical to what `userDayKey(measuredAt, userTz)` would
  produce in JS.

### Cache-invalidation hooks

Extended `invalidateUserMedications` to flush `caches.analytics` for
the user prefix. Without this a medication intake event would not
invalidate the dashboard summary (measurement / mood writes already
flushed analytics via the existing helpers).

### Estimated wall-clock

| Path | Before | After |
|---|---|---|
| Cold mount, rollup-fresh | ~4.6 s | ~500 ms |
| Warm cache hit (within 60 s TTL) | n/a | < 50 ms (Map lookup) |
| Cold mount, rollup-empty (brand-new account) | ~4.6 s | ~600 ms (DAY-bucket query returns empty, sparkline degrades gracefully) |

### Per-sub-query timing labels

Emitted under `meta.dashboard.sub_<label>_ms`:
- `dashboard.sub_latest7d_ms` — `DISTINCT ON` per type
- `dashboard.sub_sparkline_ms` — DAY rollup buckets in 7d
- `dashboard.sub_allTime_ms` — `groupBy` per type
- `dashboard.sub_todaysIntakes_ms` — today's intake events
- `dashboard.sub_streakIntakes_ms` — 365-day intake events
- `dashboard.sub_streakDays_ms` — distinct activity day-keys

## Endpoint B — `GET /api/insights/comprehensive`

### Before

The route already used `buildComprehensiveAggregate` (the SQL-aggregate
shape landed in v1.4.36). The remaining cost on the rollup-fresh happy
path came from:

| # | Query | Notes |
|---|---|---|
| C1 | `$queryRaw` narrow aggregate | 90-day full scan twice (window_stats CTE + GROUP BY). Unavoidable: the windowed/regression columns don't compose linearly across DAY buckets. |
| C2 | `$queryRaw DISTINCT ON (type)` latest per type | Cheap, indexed |
| C3 | `measurementRollup.findMany` 90-day DAY buckets | ~720 rows for 8 types |
| C4 | `measurement.findMany({ type: "BLOOD_PRESSURE_SYS" })` | ≤ 2k rows |
| C5 | `measurement.findMany({ type: "BLOOD_PRESSURE_DIA" })` | ≤ 2k rows |
| C6 | `$queryRaw SELECT MIN(measured_at)` | Cheap, indexed |

Wall-clock: ~3.4 s cold mount per Marc's HAR capture.

### After

| # | Query | Change |
|---|---|---|
| C1 | narrow aggregate | unchanged (already optimal for non-composable columns) |
| C2 | latests | unchanged |
| C3 | DAY buckets | unchanged |
| **C4+C5 → C45** | bp raw rows | **merged** into one `findMany({ type: { in: [BP_SYS, BP_DIA] } })`; partition in JS by type. Saves one RTT per request. |
| C6 | firstAt | unchanged |

Plus per-sub-query timing annotations on both the rollup-fresh and the
cold-fallback paths.

### Estimated wall-clock

| Path | Before | After |
|---|---|---|
| Cold mount, rollup-fresh | ~3.4 s | ~3.1 s (one RTT shaved by the BP merge) |
| Warm cache hit (already 60 s LRU at route level) | < 50 ms | < 50 ms |

### What I did NOT optimise

- **Narrow aggregate** (C1) — the windowed `avg7 / avg30 / avg30LastMonth`
  + `slope7 / slope30 / slope90` + `anomalyCount` columns don't compose
  linearly across DAY buckets, so the 90-day scan stays canonical. The
  v1.4.35 design call stands.
- **Cold-path heavy aggregate** — fallback path for brand-new accounts;
  one-shot cost that doesn't merit further work until the boot-time
  backfill misbehaves in prod.
- **Mood / medications findMany** inside the route handler — bounded by
  user-recorded data shape (a few hundred rows per user); not the
  hotspot.

### Per-sub-query timing labels

Emitted under `meta.insights.sub_<label>_ms`:
- `insights.sub_coverage_ms` — per-type rollup coverage probe
- `insights.sub_narrow_ms` — windowed/regression aggregate (rollup-fresh path)
- `insights.sub_heavy_ms` — full aggregate (cold-fallback path)
- `insights.sub_latests_ms` — DISTINCT ON latest per type
- `insights.sub_buckets_ms` — DAY rollup buckets read
- `insights.sub_bpRaw_ms` — bp sys+dia consolidated read
- `insights.sub_firstAt_ms` — earliest measurement timestamp

## File set

Commits:
- `eba7d6aa perf(dashboard): rollup + DISTINCT ON read for the iOS summary route` (+228 / −63)
- `0cc9f55a perf(insights): consolidated BP sys+dia read and per-sub-query timings` (+130 / −80)

Touched:
- `src/app/api/dashboard/summary/route.ts` — rewrite
- `src/app/api/dashboard/summary/__tests__/route.test.ts` — mock-shape update for the `$queryRaw` calls
- `src/lib/cache/invalidate.ts` — analytics-cache flush added to `invalidateUserMedications`
- `src/lib/insights/comprehensive-aggregator.ts` — bp-merge + per-sub-query timings
- `src/lib/insights/__tests__/comprehensive-aggregator.test.ts` — fixture update for the merged BP findMany

LOC delta: +358 / −143.

## Quality gates

- `pnpm typecheck` clean
- `pnpm lint` clean (3 pre-existing warnings unrelated to this wave)
- `pnpm test --run` on touched files: 15 / 15 passing across the
  dashboard route, comprehensive aggregator, and comprehensive route
  shape tests
- Broader smoke pass: `src/lib/insights` (162 tests) + `src/lib/cache`
  (22 tests) all green

## Recommendations for the next perf-verify

1. After deploy, capture a fresh HAR on Marc's account hitting both
   endpoints cold. Verify the new `meta.dashboard.sub_*_ms` /
   `meta.insights.sub_*_ms` annotations land in prod logs.
2. Validate cache hit ratio for `analytics.dashboard-summary` — iOS
   polling at 30 s intervals should produce > 80 % hit rate.
3. If `insights.sub_narrow_ms` still dominates at > 2 s, the next round
   should evaluate a per-type narrow aggregate sourced from rollup
   buckets for `avg7 / avg30 / avg30LastMonth` (composable when the
   bucket carries `count`-weighted sum) and only fall back to live SQL
   for slope/r2/sd.
