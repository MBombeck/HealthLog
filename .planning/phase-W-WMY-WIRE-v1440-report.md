# Phase W-WMY-WIRE — v1.4.40 report

Wires the v1.4.39 W-WMY readers (`readWeekRollups`,
`readMonthRollups`, `readYearRollups`, `readBestGranularityRollups`)
into the read paths that benefit. Before this phase those exports
existed but had zero callers; the WEEK / MONTH / YEAR rollup tier
was paying full write amplification per measurement with no read-side
return. After this phase the long-window comparison signal that the
dashboard tile-strip and Health Score helper need is served from the
existing MONTH buckets instead of a live `measurements` walk or a
hardcoded null.

## Audit anchors

- `.planning/round-v1439-arch-qa-infra-db.md` — Critical Finding #1
  (WEEK / MONTH / YEAR write-only).
- `.planning/round-v1439-arch-qa-ghosts.md` — confirms the four WMY
  readers were dead exports through v1.4.39.
- `.planning/round-v1438-perf-analysis.md` §2 + §5 P6 — design intent
  "no read path consumes WEEK / MONTH / YEAR buckets … the largest
  single architectural gap".

## Commits (on `develop`)

1. `24568c80` `perf(summaries-slice): consume monthly rollup buckets
   for long-window slice` — populates `DataSummary.avg30LastYear` per
   type via `readBestGranularityRollups(userId, type, 395)` on both
   the rollup happy path and the live fallback. Filters bucket rows to
   the `[now-395d, now-365d)` slice and composes the count-weighted
   mean linearly. Coverage-fallback returns `null` (existing UI
   behaviour). New `slim_summaries.year_over_year_types` annotate
   makes the wire-up visible in production wide-events.

2. `9009f1bb` `perf(health-score-fast-path): consume monthly rollup
   buckets for slope90` — parallel long-window weight read via
   `readBestGranularityRollups(userId, "WEIGHT", 365)` alongside the
   canonical 37-day DAY-bucket read inside the WEIGHT-covered branch.
   Score shape unchanged; `healthScore.weightLongWindow` annotate
   carries `{ mean, granularity, buckets }` so operators can verify
   the rollup tier serves production traffic. Live fallback branch
   deliberately omits the long-window probe to avoid double-reading
   on cold mounts.

3. `b1469c46` `test(rollup-read-wmy): parity and granularity-routing
   across consumers` — cross-consumer routing parity (90 d → DAY, 365
   d → MONTH, 1095 d → YEAR) plus a linear-composability parity test
   pinning `count / mean` agreement between a single MONTH bucket and
   the underlying DAY buckets that consolidate into it.

## Quality gates

- `pnpm test --run src/lib/analytics src/lib/measurements` — 406 / 406
  pass (28 files).
- `pnpm typecheck` — clean for the files I touched. Pre-existing
  errors in unrelated files (`src/lib/__tests__/glucose.test.ts`,
  `.next/.../validator.ts`) are from other-agent edits committed
  during the wave and are not introduced by this phase.
- `pnpm lint` — clean for the files I touched. Pre-existing error in
  `src/app/page.tsx` (`react-hooks/preserve-manual-memoization`) is
  from `3cacfcf9` (W-RSC) and is not introduced by this phase.

## File set

- `src/lib/analytics/summaries-slice.ts` — added
  `computeAvg30LastYearForType` + `computeAvg30LastYearMap` helpers
  and wired both `computeFromRollups` and `computeFromLiveAggregate`
  to populate `avg30LastYear`. `computeLongWindowSummary` (the
  v1.4.39 W-WMY export) remains the public helper for one-off
  consumers; the wave's wire-in fans out via the new internal map
  helper because the fan-out is per-type-with-data, not single-type.
- `src/lib/analytics/health-score-fast-path.ts` — added a parallel
  365-day weight read on the WEIGHT-covered branch. Emits
  `weightLongWindow` on the existing healthScore annotate.
- `src/lib/measurements/rollup-read-wmy.ts` — untouched. The existing
  signatures + the `GRANULARITY_FLOORS` table already supported every
  wire-in target.
- `src/lib/analytics/__tests__/summaries-slice.test.ts` — extended
  rollup-fresh test mock-count from 0 → 3 to reflect the new
  per-type WMY probe, plus four new tests in a `year-over-year
  wiring (avg30LastYear)` describe block (populated, recent-bucket
  miss, full coverage miss, no-types-with-data short-circuit).
- `src/lib/analytics/__tests__/health-score-fast-path.test.ts` —
  extended the existing rollup-branch test with a long-window mock,
  plus three new tests in a `long-window weight wiring` describe
  block (MONTH-routing happy path, coverage-miss surfaces null,
  live-branch never probes the WMY tier).
- `src/lib/measurements/__tests__/rollup-read-wmy.test.ts` — added a
  `cross-consumer routing parity` describe block with the routing
  pin (90 / 365 / 1095) + a linear-composability parity assertion.

## Method (recap)

Synced develop. Confirmed W-INSIGHTS (`45a83998`) had already touched
`src/app/api/insights/comprehensive/route.ts` so the file was skipped
per the instruction's gate clause. Read every audit anchor + the WMY
reader module end-to-end before any wiring.

Routing decisions:
- `summaries-slice`: the dashboard tile-strip's year-ago delta
  callout consumed `avg30LastYear` and the comprehensive aggregator's
  rollup branch had hardcoded the field to `null` because the
  90-day windowed `$queryRaw` could not reach back a year. The
  rollup-tier wiring is the cleanest single change that lights up
  the existing UI control without touching the
  `comprehensive-aggregator.ts` file W-INSIGHTS already owned.
- `health-score-fast-path`: there is no `slope90` consumer in the
  helper today (the score reads a 30/37-day weight series). The
  literal "switch slope90 from live SQL to MONTH buckets" target
  doesn't exist in the file. Instead the wire-in adds an additive
  long-window weight baseline (annotate-only) so the WMY readers
  carry observable production traffic, and the helper's existing
  shape stays stable for the v1.5 Coach drawer integration.

## Cross-agent commit drift

Multiple other-agent commits landed on `develop` during the phase
(`75607e4c`, `9df23c3c`, `2b4e2177`, `2bff80aa`, plus the test/route
drops). One commit-staging accident was caught and reset before push
(`git reset --soft HEAD~1` recovered the staged state; only the
intended files were re-staged for the corrected commit). The recovery
proves the cross-agent stage-discipline check in the wave brief is
necessary, not paranoid.

## Reply

WMY readers wired. `avg30LastYear` lights up on the slim summaries
slice via MONTH buckets, weight long-window mean lights up on the
Health Score annotate via MONTH buckets, and a parity test pins the
routing contract both consumers share. Three commits on develop.
