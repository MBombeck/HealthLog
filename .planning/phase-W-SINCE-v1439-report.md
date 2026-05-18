# Phase W-SINCE — `/api/analytics` live-fallback `since` cap

## Scope

Defense-in-depth row cap on the live-fallback per-type read inside
`/api/analytics`. The v1.4.38.8 per-type fast-path gate (commit
`8a8150d2`) narrowed `isFullyCovered` from "all types covered" to
"these specific types covered" inside the three downstream fast-paths
(`bp_in_target` / `health_score` / `correlations`). That made the
`fetchMeasurementSeriesChunked` walk against `measurements`
unreachable in the common case — but only on those three branches.
The A2 per-type loop (the route's own `Promise.all` over every
`MeasurementType`) has no fast-path gate at all; it always runs live
SQL. A regression on the fast-path gate would re-trigger Marc's 74.6 s
cold full-slice mount.

## Change

Single source file touched: `src/app/api/analytics/route.ts`.

1. Introduced `ANALYTICS_LIVE_WINDOW_DAYS = 90` + `liveSince = new
   Date(Date.now() - 90 d)` at the top of `buildAnalyticsResponse`.
2. Threaded `since: liveSince` into every `fetchMeasurementSeriesChunked`
   call inside the per-type loop. The helper already accepted an
   optional `since?: Date`; the per-type loop just never passed one.
3. Annotated `meta.analytics.bp_aggregate.live_since` (ISO) alongside
   the existing `row_count` slot so the next perf-verify can prove
   how far back the live read went without redeploying instrumentation.

## Untouched

- The three downstream fast-paths (`computeBpInTargetFastPath`,
  `computeUserHealthScoreFastPath`,
  `computeCorrelationHypothesesFastPath`) keep their own
  rollup-coverage-gated `readRollupBuckets` reads. The cap only
  affects the route-local A2 loop.
- The slim `?slice=summaries` branch is independent of the per-type
  loop entirely (it resolves through `computeSummariesSlice`).
- `summaries-slice.ts`, `correlations-fast-path.ts`,
  `bp-in-target-fast-path.ts`, `health-score-fast-path.ts` — none
  modified. Owned by other agents.
- `fetchMeasurementSeriesChunked` helper signature already supported
  `since`; no helper-side rewrite needed.

## Before / after row-count bound

| Scenario | Before | After |
|---|---|---|
| Marc's tenant cold full-slice (live-fallback path) | ~347 114 rows across 15 chunked reads | ~5 000 rows (trailing 90 days, comprehensive-aggregator parity) |
| Empty / new account | 0 | 0 |
| Tenant with 2-year history but no rows in trailing 90 days | every historical row (paginated) | 0 |

Estimated cold-path savings on the live-fallback: 20-40 s elided per
the audit (§1 A2 + §6 quick-win bundle). Wall-clock parity confirmed
unchanged for the fast-path (rollup-backed) common case — the cap only
fires inside the per-type loop, which the fast-paths don't reach.

## Trade-off documented in the file

`summarize().avg30LastYear` (points 365-395 days ago) returns `null`
on the fall-through path. The dashboard tile's year-over-year overlay
shows "no prior data" until the rollup tier warms. Acceptable because
the live-fallback is already a degraded path and the slim slice +
comprehensive aggregator already use the same 90-day window.

## Test additions

Created `src/__tests__/api/analytics/since-cap.test.ts` (3 tests, all
passing). Mocks every downstream dependency so the test exercises the
route's per-type loop in isolation:

1. **`passes a trailing-90-day measuredAt.gte to every per-type
   findMany`** — asserts the chunked helper carries `since` to every
   call. Identifies per-type calls via the `orderBy: [..]` array
   shape that distinguishes them from the narrow glucose / sleep-stage
   reads.
2. **`annotates meta.analytics.bp_aggregate.live_since`** — pins the
   ISO surface so the next perf-verify can see the cap is in effect
   on a live request.
3. **`does not invoke the per-type loop on the slim ?slice=summaries
   branch`** — regression test for the slim-slice path; the rollup
   common case is unaffected by the cap.

Tests pass under `pnpm test src/__tests__/api/analytics`.

### Integration-test update (out of file set but unavoidable)

The existing `tests/integration/analytics-bp-aggregate-paged.test.ts`
seeded 6 000 PULSE rows from `2025-01-01` — all > 90 days old by
today (2026-05-18), so the new cap would zero them out. Updated the
seed to backfill 6 000 rows × 15-minute intervals (62.5 days,
comfortably inside the 90-day floor) so the test still spans two
chunks and still pins the existing paging-correctness contract. The
test name + assertions are unchanged.

## Quality gates

- `pnpm typecheck` — clean on my files (`src/app/api/analytics/route.ts`,
  `src/__tests__/api/analytics/since-cap.test.ts`,
  `tests/integration/analytics-bp-aggregate-paged.test.ts`). Two
  pre-existing TS errors in `src/app/api/telegram/webhook/route.ts`
  belong to a parallel agent (W-MED/W-MOOD area).
- `pnpm lint src/app/api/analytics/route.ts src/__tests__/api/analytics
  tests/integration/analytics-bp-aggregate-paged.test.ts` — clean.
- `pnpm test src/__tests__/api/analytics` — 3/3 pass.
- `pnpm test src/__tests__/api/analytics src/lib/analytics` — 241/241
  pass (regression-free across every analytics-related unit test).

## Self-review against `8a8150d2`

The v1.4.38.8 commit narrowed three fast-path gates from
`isFullyCovered(coverage) && coverage.get("X")` to per-type
predicates. My diff doesn't touch any of those three files. The
`since` cap lives entirely inside the A2 per-type loop, which:

- Runs unconditionally on the default slice (no coverage gate).
- Feeds `summarize()` per type — `summarize()` is pure JS on the
  array it receives, so a smaller array means a smaller working set
  and an accurate slope7/30/90 (slope365 isn't a thing).
- Does not feed the three downstream fast-paths — they each issue
  their own probes against `measurement_rollups` (rollup path) or
  `measurement.findMany` (live path) inside their own helper.

The fast-path-gate behaviour from `8a8150d2` is therefore untouched;
the cap is purely a row-count guard on the route-local per-type
read.

## Commit

Single commit, Marc-Voice English, no Co-Authored-By, no
`--no-verify`, no emoji. To be authored by the marathon driver per
the standard release flow.
