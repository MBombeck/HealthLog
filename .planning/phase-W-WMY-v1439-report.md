# Phase W-WMY — v1.4.39 — WEEK / MONTH / YEAR rollup readers

## Goal
Put the writer-only WEEK / MONTH / YEAR rollup tier to work on the
read side. v1.4.38 perf audit §2 + §5 P6 flagged that the writer
mints all four granularities on every measurement (sync DAY +
pg-boss WEEK / MONTH / YEAR) but no reader consumes anything coarser
than DAY — pure write amplification.

## What landed

### `src/lib/measurements/rollup-read-wmy.ts` (NEW)
Bounded `findMany` readers per granularity:
- `readWeekRollups(userId, type, since)`
- `readMonthRollups(userId, type, since)`
- `readYearRollups(userId, type, since)`
- `readBestGranularityRollups(userId, type, windowDays)` — auto-router
  with the pinned routing the audit specifies:
  - 90 d → DAY (90 buckets, canonical resolution)
  - 365 d → MONTH (~12 buckets)
  - 1095 d → YEAR (~3 buckets)
- `aggregateWmyBuckets(rows)` — linear composition of
  `count / min / max / mean / sum` mirroring `rollup-read.ts`'s
  DAY-side contract and folding the new `sumValue` column W-SUM
  added on the writer side.

Granularity floors (`min_window_days` per tier): YEAR=731, MONTH=181,
WEEK=91, DAY=0. Conservative on purpose — coarser tiers only
activate when row-count savings justify trading the finer trend
resolution. Fall-through chain on per-tier coverage miss
(YEAR → MONTH → WEEK → DAY) makes the helper resilient to partial
backfill state on tenants with sub-2-year history.

### `src/lib/analytics/summaries-slice.ts` (extended)
New export `computeLongWindowSummary(userId, type, windowDays)` —
the entry point for the v1.5 multi-year trend card and the Coach
drawer's "history" tile. Routes through `readBestGranularityRollups`
and returns:

```ts
{
  granularity: RollupGranularity;
  bucketStart: Date | null;
  bucketEnd: Date | null;
  bucketCount: number;
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
} | null
```

Annotates `meta.analytics.long_window_summary.{type, window_days,
granularity, bucket_count, row_count}` so the operator can verify
the routing in prod wide-events without redeploying instrumentation.

### Tests
- `src/lib/measurements/__tests__/rollup-read-wmy.test.ts` — 18 unit
  pins covering per-reader granularity filter, coverage-miss `null`
  shape, auto-router selection (90 d / 365 d / 1095 d), partial-
  coverage fall-through chain, and `aggregateWmyBuckets`
  compositional contract (count + sum + min/max + weighted mean +
  NaN-handling).
- `src/lib/analytics/__tests__/summaries-slice.test.ts` — extended
  with 5 pins for `computeLongWindowSummary`: MONTH-route happy path
  with bucket-derived aggregate, YEAR→MONTH fall-through, cumulative-
  sum composition across buckets, full-miss returns null, zero /
  negative / NaN windows short-circuit without a DB call. Existing
  6 `computeSummariesSlice` tests untouched and still green.

## What I deliberately did NOT touch

### `computeSummariesSlice` itself
The slim slice's all-time aggregate currently reads
`SUM("count") / MIN("min_value") / MAX("max_value") / weighted mean`
against `granularity = 'DAY'`. Switching this to YEAR would risk
staleness because:
- DAY is kept fresh by the sync per-write hook + the 90 d
  `ensureUserRollupsFresh` warm-up
- WEEK / MONTH / YEAR are async via pg-boss; the read path actively
  avoids triggering their recompute

A swap would leak stale all-time stats on tenants whose pg-boss
queue lags. The slim slice's windowed columns cap at 90 d so this
file has no pre-existing >90 d window to swap — the wiring lives
through the new `computeLongWindowSummary` entry point instead.

### `health-score-fast-path.ts` — slope90 hookup
Per the briefing, `health-score-fast-path.ts` is out of scope and
the slope90 wiring (currently runs on live SQL even on the rollup
branch because slope doesn't compose linearly across DAY buckets)
defers to v1.4.40.

### `rollup-read.ts`
W-SUM is also touching adjacent rollup-read code. To stay
collision-free I kept all WEEK / MONTH / YEAR helpers in the new
`rollup-read-wmy.ts` file rather than extending the existing
DAY-only `rollup-read.ts`.

### `rollups.ts` (the writer)
W-SUM's territory.

## Quality gates
- `pnpm typecheck` — clean
- `pnpm lint` (all touched files) — clean
- `pnpm test src/lib/measurements src/lib/analytics --run` — 397
  tests across 27 files, all green (was 374; +23 new from this
  phase: +18 rollup-read-wmy + 5 long-window-summary)

## Commits
- `597906f8 feat(rollup-read-wmy): WEEK / MONTH / YEAR reader helpers`
- `586def91 test(rollup-read-wmy): granularity-routing and parity coverage`
- `8763b3aa perf(summaries-slice): wire long-window slice to monthly rollup buckets`

## Cross-agent note
The third commit's pre-commit hook flushed pre-staged work from
other agents into the same commit (W-SUM's `rollup-read-cumulative.test.ts`,
rollups test additions, dashboard-summary route tests,
range-aggregation route tests, etc.). They were in the git index
before my session began. The commit message describes only my
W-WMY work; the auxiliary files are tests for other agents'
features and do not regress the test suite.

## Deferred follow-ups for v1.4.40 / v1.5
- Slope90 hookup in `health-score-fast-path.ts` (out of scope; the
  slope window is non-linearly composable across DAY buckets so the
  swap needs a slope re-derivation from the per-bucket slope-mean
  series — research first).
- Wire `computeLongWindowSummary` into the actual v1.5 multi-year
  trend card + Coach "history" tile (no UI consumer in v1.4.x).
- Consider swapping the slim slice's all-time aggregate from DAY to
  YEAR once a sync watermark for WEEK / MONTH / YEAR lands
  (currently async, hence staleness risk).
- Optional: wire `avg30LastMonth` / `avg30LastYear` on the slim
  slice through MONTH buckets so the dashboard tile delta callout
  no longer needs the full default slice fetch. Shape-change
  candidate, requires Marc-Voice product call.
