# W-POOL — v1.4.40 phase report

## Directive

Empirical-trace finding #1 from `.planning/round-v1439-empirical-trace.md`:
`/api/analytics` thick monopolises the Prisma pool for 6.5 s. 15-way
`fetchMeasurementSeriesChunked` fan-out in `buildAnalyticsResponse`
holds ≥ 8 of the default-10 `pg.Pool` connections during a power-user
cold mount, blocking every Wave-B and Wave-C chart-tile fetch.

Mitigations chosen (per trace §F1 + §F2):

1. Wrap the per-type `Promise.all` in `p-limit(4)` so analytics holds
   at most 4 pool slots at any moment.
2. Raise `pg.Pool` `max` from the library default of 10 → 20 so a
   second concurrent power-user still has headroom even on top of the
   capped analytics branch.

## Scope (touch-disjoint with W-INSIGHTS / W-DELETED / W-RSC / W-PRIVACY / W-AASA / W-APNS-NOTIFY / W-CONSENT)

In:
- `src/lib/db.ts` (raised pool max + `getPoolMax()` resolver)
- `src/app/api/analytics/route.ts` (p-limit wrapper + cap export)
- `src/lib/__tests__/db.test.ts` (new — pool ceiling)
- `src/app/api/analytics/__tests__/route.test.ts` (extended — concurrency cap)
- `package.json` + `pnpm-lock.yaml` (`p-limit@7.3.0`)

Out (left alone, owned by sibling agents):
- `src/app/page.tsx` (W-RSC)
- `src/components/charts/mood-chart.tsx` (W-RSC)
- Anything under `src/app/api/insights/` (W-INSIGHTS)
- `src/app/.well-known/apple-app-site-association/route.ts` (W-AASA, already
  staged when W-POOL started — verified untouched in our diff stack)

## File → SHA

| Commit | SHA | Files |
|---|---|---|
| `perf(analytics): bound 15-way Promise.all to 4 concurrent type-fetches` | `96b2ee4c` | `src/app/api/analytics/route.ts`, `package.json`, `pnpm-lock.yaml` |
| `perf(db): raise Prisma pg.Pool max to 20 for power-user fan-out headroom` | `3b8f4111` | `src/lib/db.ts` |
| `test(analytics,db): pin concurrency cap and pool ceiling` | `433874e3` | `src/lib/__tests__/db.test.ts` (new), `src/app/api/analytics/__tests__/route.test.ts` |

HEAD before W-POOL: `c9d5479b`. HEAD after W-POOL: `433874e3`.
(Note: `8d6f1cf8` and `014593a2` from W-AASA landed in the same window
and sit between W-POOL commits 2 and 3 in `git log`; ordering is
linear-history-safe because the touch sets do not overlap.)

## Implementation notes

**`src/lib/db.ts` — `getPoolMax()` env-resolver.**
Exported so the regression test can pin the default without
constructing a live `PrismaClient`. Default `20`, overridable via
`DATABASE_POOL_MAX`. Falls back to 20 on malformed or non-positive
values. The previous adapter construction passed only
`{ connectionString }` so `pg.Pool` silently used its library-default
ceiling of 10. The new shape passes `{ connectionString, max:
getPoolMax() }` — `pg.PoolConfig` accepts `max?: number` per
`@types/pg/index.d.ts:46-48`.

**`src/app/api/analytics/route.ts` — `ANALYTICS_TYPE_FETCH_CONCURRENCY`.**
Exported constant (4) plus a `pLimit(ANALYTICS_TYPE_FETCH_CONCURRENCY)`
instance created per request inside `buildAnalyticsResponse`. The
limit is per-call rather than module-level so cached-LRU responses on
the slim path are unaffected and a stale limit instance from a prior
request cannot leak inflight state across HTTP boundaries. The
existing `Promise.all` over `types.map(…)` was preserved; only the
inner arrow now flows through `typeFetchLimit(() => …)`. The
`fetchMeasurementSeriesChunked → .then(measurements => …)` body and
its return shape are untouched.

## Tests delta

Before: 4 tests in `src/app/api/analytics/__tests__/route.test.ts`,
1 test file in `src/lib/__tests__/` covering `db.ts` (`db-to-json.test.ts`
with 6 cases on the `toJson` helper only).

After:
- `src/lib/__tests__/db.test.ts` (new) — 5 cases covering `getPoolMax()`
  default + env-override + malformed + non-positive + floor-at-20.
- `src/app/api/analytics/__tests__/route.test.ts` — 1 new case
  ("caps per-type Prisma fan-out at ANALYTICS_TYPE_FETCH_CONCURRENCY")
  that instruments the `findMany` mock with `inflight` / `peak`
  counters and a 20 ms timer per call, asserting:
  - `peak ≤ ANALYTICS_TYPE_FETCH_CONCURRENCY`
  - `calls ≥ 8` (sanity)
  - `40 ms ≤ elapsed < calls × 20 ms` (catches unbounded `Promise.all`
    on the low end and accidental serialisation on the high end).

Full suite delta: + 6 unit tests (5 db + 1 analytics).
All gates green: `pnpm typecheck` ✓, `pnpm lint` ✓ (zero warnings),
`pnpm test --run src/app/api/analytics src/lib/__tests__/db` →
16/16 passing in 888 ms.

## Performance expectation

Per the empirical trace §B1 / §F1:
- Wave-C chart-tile burst (6 × `/api/measurements?source=rollup`) moves
  from a single ~+7.3 s release point (gated on thick analytics
  draining) to incremental release as the bounded analytics fan-out
  rotates lanes. Expected first-paint of the chart row drops from
  ~7.3 s to ~1.6 s on the empirical fixture.
- Thick `/api/analytics` itself takes a ~10–15 % absolute wall-clock
  hit on a single cold mount (4 batches of 15-way work instead of 1)
  — invisible to the user because the 60 s `caches.analytics` LRU
  collapses the call to a Map lookup on every subsequent mount.
- Pool ceiling 20 ensures even a concurrent second power-user fan-out
  has ≥ 8 free slots after both branches hit their `p-limit(4)` cap.

## Deferred

None within W-POOL scope. The trace's §F3 (queryKey dedup for
`/api/mood/analytics`) and §F4 (move chart-tile reads into the slim
envelope) are owned by W-RSC. §F5 (defer version-poller) is out of
scope for this phase.
