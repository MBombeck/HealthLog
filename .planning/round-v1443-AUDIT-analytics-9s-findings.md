# v1.4.43 /api/analytics 9s perf investigation

## Verdict

**URGENT** — both `/api/analytics` (default + `?slice=summaries`) wait
~9 030 ms server-side on every dashboard mount of the live v1.4.42
tree. The regression has been latent since v1.4.40 W-WMY-WIRE and was
masked through v1.4.41/42 because no other endpoint moved. It is the
single largest user-visible regression on the v1.4.42 deploy and must
land in v1.4.43.

## Root cause

`src/lib/analytics/summaries-slice.ts:731-750`
(`computeAvg30LastYearMap`) is an **unbounded `Promise.all` fan-out**
over the per-type list of measurement types with data. It was
introduced in v1.4.40 W-WMY-WIRE (commit `24568c80`,
`perf(summaries-slice): consume monthly rollup buckets for long-window
slice`). Both `computeFromRollups`
(`src/lib/analytics/summaries-slice.ts:421`) and
`computeFromLiveAggregate`
(`src/lib/analytics/summaries-slice.ts:584`) call it unconditionally
on every slim-slice request.

On Marc's tenant `typesWithData.length` is ~15 (every measurement type
the dashboard tile-strip surfaces). For each type the helper invokes
`readBestGranularityRollups(userId, type, 395)`
(`src/lib/rollups/measurement-read-wmy.ts:133-155`), which **sequentially**
walks `GRANULARITY_FLOORS` from coarsest to finest. With `windowDays=395`
the loop tries MONTH (floor 181) first, then WEEK (91), then DAY (0)
— up to **three sequential Prisma round-trips per type** when MONTH /
WEEK coverage is partial. The only coverage the boot-time inline
refresh (`ensureUserRollupsFresh`,
`src/lib/rollups/measurement-rollups.ts:632-642`) guarantees is DAY
(trailing 90 d); WEEK/MONTH/YEAR depend on the v1.4.35.1 background
`rollup-full-backfill` queue and per-write hooks having converged.

So on a hot dashboard mount with two concurrent `/api/analytics`
requests:

- **Slim** (`computeFromRollups`) holds 3 base slots (narrows /
  latests / dayBuckets `$queryRaw`) and then **bursts 15 simultaneous
  `findMany`s** against `measurement_rollups`. Each can serialise into
  2-3 round-trips on coverage miss.
- **Thick** (`buildAnalyticsResponse`) probes coverage, fans out 15-way
  per-type live walks behind `p-limit(4)` (4 slots), runs two parallel
  `computeBpInTargetFastPath` calls (4 slots for the rollup pair-read),
  `correlations-fast-path` (3 slots), `health-score-fast-path` (4
  parallel slots), plus stand-alone `sleepStages` + `glucoseByContext`
  findManys (2 slots).
- **Background**: each route fires `void
  ensureUserRollupsFresh(userId)` which itself holds 2 slots for the
  watermark probe and, when stale, a `recomputeUserRollups` of the
  DAY window.

Peak concurrency easily exceeds the `pg.Pool` max of 20 (see
`src/lib/db.ts:35`). The W-POOL `p-limit(4)` cap on the per-type
live walk inside the thick route (`route.ts:55`,
`ANALYTICS_TYPE_FETCH_CONCURRENCY`) was added in v1.4.40 explicitly to
prevent this — but the same release added the W-WMY-WIRE fan-out in
the slim slice WITHOUT any equivalent cap. The two concurrent routes
now drown the pool that v1.4.40 raised from 10→20 specifically to
absorb this kind of burst.

Secondary contributors (audited but NOT the dominant cost):

- `computeFromRollups`'s three lead `$queryRaw`s are correctly
  parallelised in one `Promise.all`. They are not the bottleneck.
- The thick route's `summarize()` per-type fan-out is correctly capped
  at 4. Its 425-day cap (`route.ts:264`) is in place.
- `probeRollupCoverage` (`src/lib/rollups/measurement-coverage.ts:45`)
  is one indexed query and lands sub-50 ms in practice.
- `glucoseByContext` and `sleepStages` are both bounded to 30 days and
  narrow projections — fine.
- The cache (`caches.analytics`, 60s TTL) is keyed
  `{userId}|summaries` vs `{userId}|default`. Both miss simultaneously
  on cold mount; both are single-flighted **per key** but NOT across
  keys, so the two slices fire concurrently. Correct behaviour, but
  exposes the pool to the combined fan-out below.

## Recommended fix

Two-line minimum-delta change — cap the WMY fan-out with the same
`p-limit` discipline v1.4.40 W-POOL applied to the thick route.

### `src/lib/analytics/summaries-slice.ts`

Add `import pLimit from "p-limit";` at the top of the file (alongside
the existing imports — already a project dependency, used in
`src/app/api/analytics/route.ts:1`).

Replace `computeAvg30LastYearMap`
(`src/lib/analytics/summaries-slice.ts:731-750`) with:

```ts
/**
 * v1.4.43 — cap concurrent per-type WMY reads at 4.
 *
 * Pre-fix this helper ran an unbounded Promise.all over every type
 * the user has data for. On a 15-type tenant the burst held 15+
 * Prisma slots simultaneously, and with the slim and thick analytics
 * slices firing in parallel on dashboard mount the combined fan-out
 * drowned the pg.Pool max=20 even after the v1.4.40 W-POOL raise.
 *
 * Capping at 4 keeps the same total work but holds at most 4 slots
 * for the WMY branch of the slim slice at any moment, leaving
 * headroom for the concurrent thick slice's own fan-outs.
 */
const WMY_FANOUT_CONCURRENCY = 4;

async function computeAvg30LastYearMap(
  userId: string,
  types: ReadonlyArray<string>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (types.length === 0) return out;
  const limit = pLimit(WMY_FANOUT_CONCURRENCY);
  const results = await Promise.all(
    types.map((type) =>
      limit(async () => {
        const value = await computeAvg30LastYearForType(
          userId,
          type as MeasurementType,
        );
        return [type, value] as const;
      }),
    ),
  );
  for (const [type, value] of results) {
    out.set(type, value);
  }
  return out;
}
```

That alone collapses the slim-slice burst back to 4-at-a-time, which
matches the thick slice's existing W-POOL cap.

### Optional follow-up (defer to v1.4.44 if v1.4.43 needs minimum-delta)

If perf-verify confirms the cap fix is insufficient on its own, two
incremental escalations are available:

1. **Pin the WMY router to the granularity the boot backfill
   actually mints.** Today `readBestGranularityRollups(395)` falls
   through MONTH → WEEK → DAY on coverage miss. If the tenant has
   converged DAY but not MONTH, the helper pays the cost of two
   miss probes per type before landing on DAY. The cheap fix is to
   issue a single MONTH-or-DAY read using the per-type coverage map
   the route already probed (`route.ts:209` /
   `summaries-slice.ts:221`) instead of a sequential floor walk.
   See `.planning/round-v1438-perf-analysis.md` §2 for the original
   "WMY tier sits as write amplification" framing.

2. **Hoist `computeAvg30LastYearMap` behind a per-(userId,date) cache.**
   The 395-day window is anchored on `Date.now()` so the result is
   stable across an entire calendar day. A 24h TTL in
   `caches.analytics` keyed on a `${userId}|avg30-last-year-${ymd}`
   shape would collapse the burst to zero on warm days. The current
   `caches.analytics` envelope already carries the full slice; the
   per-call sub-helper just doesn't see the cache because it lives
   inside `computeFromRollups`.

Neither follow-up is required to close the 9 s regression; the
`p-limit(4)` cap is the single minimum-delta land.

## Expected delta

Empirical reference points from the v1.4.39 cold-mount trace
(`.planning/round-v1439-empirical-trace.md` § B1-B3) and the v1.4.40
W-POOL closure show:

- W-POOL `p-limit(4)` on the thick route's 15-way per-type walk took
  the pool-wait from 6.5 s → ~1.5 s under a similar burst.
- The slim slice's pre-W-WMY-WIRE timing (v1.4.37) was 1.5-3 s cold,
  <100 ms warm. Adding the 15-way WMY fan-out in v1.4.40 widened the
  cold-mount window proportionally.

Projecting the same `p-limit(4)` shape onto the slim slice:

| state | before | after (est) |
|---|---|---|
| dashboard mount, both slices cold | 9.0 s + 9.0 s in parallel | ~2.0-3.0 s + ~2.0-3.0 s in parallel |
| dashboard mount, slim warm + thick cold | ~9.0 s thick | ~2.0-3.0 s thick |
| dashboard mount, both warm (60s TTL hit) | ~50 ms | ~50 ms |
| WMY tier converged + cap applied | n/a | <500 ms cold (best case) |

The cap restores the v1.4.37 target band (1.5-3 s) under combined
slim+thick concurrent load. Warm-cache behaviour is unchanged.

## Test plan

1. **Unit** — extend
   `src/lib/analytics/__tests__/summaries-slice.test.ts` with a test
   that mocks `computeAvg30LastYearForType` and asserts the helper
   never holds more than 4 in-flight calls simultaneously. Pattern
   mirrors the v1.4.40 `route.test.ts` test pinning
   `ANALYTICS_TYPE_FETCH_CONCURRENCY=4`
   (`src/app/api/analytics/__tests__/route.test.ts` —
   `pin concurrency cap and pool ceiling`, commit `433874e3`).

2. **Integration** — add a smoke test that issues a concurrent
   `?slice=summaries` + default request against a seeded
   15-type tenant and asserts both resolve under 5 s. Place
   alongside the existing `route.test.ts` integration suite.

3. **Wide-event probe** — in production, after deploy, confirm both
   routes emit `meta.analytics.slim_summaries.path:"rollup"` AND a new
   `wmy_fanout.concurrency: 4` annotate (add to the helper's annotate
   call alongside `slim_summaries` block so ops can prove the cap
   fired). Compare wall-clock to the HAR baseline.

4. **HAR re-capture** — Marc to re-record the live tree post-deploy
   and replace `.planning/v1442-postdeploy-new1.har` with the
   post-fix capture. Both `/api/analytics*` rows should land in the
   2-3 s band.

## Related findings

- **WMY rollup tier dead-write-amplification risk**: the v1.4.38 perf
  audit (`round-v1438-perf-analysis.md` § 2, P6) flagged that
  WEEK/MONTH/YEAR rollups are written on every measurement but never
  read. v1.4.39 W-WMY readers + v1.4.40 W-WMY-WIRE wiring closed
  that — but the wiring landed without a concurrency cap, which is
  exactly the regression this report documents. The pattern
  recurrence (Read-swap should replace, not parallel-run — see the
  memo `feedback_read_swap_replace_not_parallel.md`) is worth
  surfacing for the v1.4.43 marathon retrospective.

- **Boot backfill MONTH/WEEK coverage**: `ensureUserRollupsFresh`
  (`src/lib/rollups/measurement-rollups.ts:632`) inlines only the
  DAY refresh. If the per-write hooks or boot backfill have not
  drained the MONTH partition for a user, every WMY call pays a
  miss-probe penalty before landing on DAY. The v1.4.35.1
  `rollup-full-backfill` queue (`enqueueBootTimeRollupBackfill`,
  `measurement-rollups.ts:688`) should be doing this on each worker
  boot — operator verification via `pg-boss` queue depth on
  `ROLLUP_FULL_BACKFILL_QUEUE` would confirm. Not on the v1.4.43
  critical path; deferrable to a v1.4.44 ops doc.

- **Cache key splitting**: the analytics cache uses
  `${userId}|summaries` and `${userId}|default` as separate keys
  (`route.ts:96` and `route.ts:115`), so the two concurrent dashboard
  fetches do NOT share a single-flight. Each must compute
  independently. Acceptable today (different response shapes), but
  if v1.5 unifies the analytics envelope a single-flight collapse
  would halve the cold-mount cost outright.

- **`mood/analytics` at 200 ms (HAR row 3)** is healthy — it does
  not share the WMY fan-out and serves directly from
  `mood_entry_rollups` (`src/lib/rollups/mood-rollups.ts`). No
  action.

- **`ensureUserRollupsFresh` void-fire**: the v1.4.37.1 hotfix
  decoupling was correct and remains. The in-flight dedup map
  (`measurement-rollups.ts:582-588`) handles the concurrent slim+thick
  case correctly — both join the same promise. No action.

- **Charts intermittent empty-state ("Erfasse mindestens 3
  Einträge…")**: traceable to the slim slice's 9 s tail letting the
  chart's `count >= 3` predicate evaluate against an undefined
  summary before the response lands. Capping the fan-out closes this
  symptom as a side effect — the chart will see the populated
  `summary` within the 2-3 s window TanStack Query's `useQuery`
  loading skeleton already accommodates. No separate fix needed.
