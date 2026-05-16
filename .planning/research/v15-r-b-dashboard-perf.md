---
file: .planning/research/v15-r-b-dashboard-perf.md
purpose: Incremental dashboard perf audit after v1.4.28 — why the dashboard still feels slow, why pulse is the slowest tile
created: 2026-05-16
contributor: R-B
---

# v1.5 R-B — Incremental dashboard perf audit

## What the dashboard is actually waiting on

The dashboard's perceived slowness after v1.4.28 is not driven by the
chart-data fetch any more — H0 closed that vector. The remaining lag
sits in two places. The first is `/api/analytics`, an aggregator that
on every dashboard mount walks every persisted row of every measurement
type via a chunked Prisma pager, then runs the in-memory `summarize()`
helper across each of those row sets. For a small seeded demo the route
returns in ~290 ms (median over five samples); for a power user with
multi-year Apple Health backfill the per-type read costs scale linearly
with row count, and `summarize()` re-sorts the full series three times
(once per `trendSlope` window) plus spreads it twice through
`Math.min/Math.max(...values)`. The second is the dashboard's React
mount pipeline: a single `useAuth()` gate serialises the first paint
behind `/api/auth/me`, and only then do three parallel React-Query
fetches fan out — `/api/analytics`, `/api/dashboard/widgets`, and
`/api/mood/analytics` — joined a beat later by
`/api/gamification/achievements` from the `AuthShell`. None of those
gate-after-auth queries have a `staleTime` longer than 60 s except
`useAuth` itself, so a hard reload pays the full cost every visit.

The pulse chart specifically feels slowest because pulse data density
is structurally higher than every other metric the dashboard renders.
A continuous-monitoring source (Apple Watch, Withings ScanWatch) writes
a pulse sample on the order of once per minute; weight, BP, body fat,
mood, and sleep all write at most once per day. When the chart pulls
its bounded 30/90/365-day window the server still returns up to 5 000
raw rows for pulse (the post-H0 ceiling) versus a few dozen for weight.
That's a Recharts re-render on a series an order of magnitude larger
than its siblings, every time the user switches range tabs. The
server-side aggregation path that would collapse those 5 000 rows into
~365 daily buckets — `aggregate=daily` on `/api/measurements` — is
deployed but never invoked by the client, AND when I probed it
end-to-end on the live demo it returns HTTP 500. The closure report
already flagged the "client never sets `aggregate`" deferral as
SD-H1; what it did not catch is that the server side is also broken,
so even when v1.4.29 wires the client, today's server code will hand
back errors instead of buckets.

## Live TTFB baseline

All medians over five samples against the public demo (`demo / demo123demo123`).
Production was sampled in dry-run shape (login pages, version endpoint)
and matched the demo numbers within ~30 ms; authed prod was not
exercised to avoid noise on the maintainer's account.

| Endpoint                                  | Median TTFB | Note                                                |
|---|---|---|
| `/api/auth/me`                            | 110 ms     | Gates every dashboard query                          |
| `/api/dashboard/widgets`                  | 111 ms     | Cheap, JSON-blob read                                |
| `/api/mood/analytics`                     | 105 ms     | Mood entries scoped to 30 days                       |
| `/api/gamification/achievements`          | 147 ms     | Fired by `AuthShell`, refetches every 120 s          |
| `/api/insights/pulse-status`              | 124 ms     | Web only, retry: 0, 20 s upstream timeout            |
| `/api/analytics`                          | **287 ms** | Dominant cost on the dashboard, seed data only       |
| `/api/measurements?type=PULSE` 30/90/365d | 109-111 ms | Bounded window, demo seed of ~60 days of data        |
| `/api/measurements?type=PULSE` all-time   | 125 ms     | Same row count as 365d on demo                       |
| `/api/measurements?type=WEIGHT` 90d       | 110 ms     | Reference: low-density type                          |
| `/api/measurements?...&aggregate=daily`   | **500**    | Server-side aggregation path is broken in production |
| `/` (HTML, authed)                        | 127 ms     | Server roundtrip, no waterfall yet                   |
| `/insights/puls` (HTML, authed)           | 113 ms     | Same                                                 |

The demo seed is too sparse to expose the volume-scaling tail: pulse
and weight return in roughly the same time because both are bounded
windows that fit comfortably under the demo's row count. For an
account with a year of Apple-Watch pulse samples and a few thousand
manual or ingested rows across the other metric types, `/api/analytics`
should be the slow leader by a wide margin — every `summarize()` call
is super-linear in series length.

## Hotspots — severity-grouped

### Critical

| ID | Location | Impact | Fix shape | Effort |
|---|---|---|---|---|
| C1 | `src/app/api/analytics/route.ts:60-116` | The route iterates `measurementTypeEnum.options` (~30 types), pages every persisted row of every type through `fetchMeasurementSeriesChunked`, and feeds the full series into `summarize()`. For high-density types the read alone allocates a few MB of `MeasurementType[]` rows per request, and the sort/spread/anomaly passes are O(N log N) each. The maintainer's perceived dashboard lag almost certainly lives here. | Run aggregation in SQL with `prisma.groupBy` or a `date_trunc` SQL view that returns one row per `(type, day)` with `avg`, `min`, `max`, `count`. Drop the in-memory full-series walk for everything except trend slope, which only needs daily buckets anyway. Cap the request to "last 365 days" — anything older is already painted into the all-time mini chart, not the dashboard tile. | M |
| C2 | `src/app/api/measurements/route.ts:74-94` (the `aggregate` branch) | Server-side range aggregation returns HTTP 500 in production for all three grains (`daily`, `weekly`, `monthly`). Confirmed against `demo.healthlog.dev` for every grain. The Prisma `$queryRaw` call passes `${truncUnit}` as a bound parameter to `date_trunc`, which Postgres rejects because the function's first argument must be a literal in the prepared statement. Tests pass only because they mock `prisma.$queryRaw` — the real path was never executed end-to-end. This is the entire foundation that v1.4.29's SD-H1 client wire-up plans to consume. | Switch from `${truncUnit}` (parameter) to `Prisma.sql` interpolation for the grain literal, or build the SQL string with whitelisted grain tokens inline. Add an integration test that hits a real Postgres (the existing test-container fixture in `src/lib/db/__tests__`) rather than a mocked `$queryRaw`. | S |
| C3 | `src/components/charts/health-chart.tsx:572-613` (the chart-data fetch loop) | Even after H0 bounded the window, the chart pulls raw rows: `limit=5000` for pulse means up to ~5 000 points per type per request, then the client groups by day in JavaScript. For a continuous-monitoring user the response is ~150-500 KB per chart per range-tab change; Recharts then paints a sub-1-pixel-spaced line that takes 200-500 ms to draw on a mid-range phone. | Have the chart always pass `aggregate=daily` for windows over 7 days. Server returns one row per day. Drop the client-side `Map` aggregation loop entirely. Bound payload at ~365 rows per type instead of 5 000. (Depends on C2 landing first.) | S |
| C4 | `src/hooks/use-chart-overlay-prefs.ts:38-53` | The hook reads `/api/dashboard/widgets` under cache key `["dashboard-layout"]`. The rest of the codebase uses `queryKeys.dashboardWidgets()` → `["user", "dashboardWidgets"]`. Same endpoint, two cache slots. The dashboard fires both keys on mount; the overlay-prefs cache never warms from the dashboard's primary fetch and vice-versa. Comment on the hook (line 19) claims "Reads from the existing dashboard-widgets cache" — that claim is false, the keys diverge. | Replace `["dashboard-layout"]` with `queryKeys.dashboardWidgets()` so both consumers share one cache slot. One file, four lines. | XS |

### High

| ID | Location | Impact | Fix shape | Effort |
|---|---|---|---|---|
| H1 | `src/lib/analytics/trends.ts:171-247` (`summarize()`) | Sorts the series by date, then calls `trendSlope(data, …)` three times — each of which **re-sorts** the same series. Plus `Math.min(...values)` and `Math.max(...values)` allocate spread arrays that can blow the V8 argument-count limit (~50 k entries) on pulse-rich accounts. `detectAnomalies(data)` is another O(N) walk. Five O(N log N) passes per type, ~30 types, every dashboard mount. | Pass the already-sorted series down into `trendSlope`; replace `Math.min/max(...values)` with a single reducer loop; share the mean/std-dev pre-compute between `summarize` and `detectAnomalies`. Pure-function rewrite, no contract change. | S |
| H2 | `src/app/api/analytics/route.ts:213-228` (`glucoseRows.findMany`) | Reads every `BLOOD_GLUCOSE` row the user has ever written, with no time bound. For a user logging 4-6 readings per day for a year that's a few-thousand-row fetch on every dashboard mount, none of which is needed for the headline tiles (`avg7`, `avg30`, `latest` only need the trailing window). | Bound `where.measuredAt: { gte: thirtyDaysAgo }` for the dashboard tile path; keep the full-history path on the dedicated `/insights/glucose` sub-page if it ever lands. | XS |
| H3 | `src/hooks/use-auth.ts:34-49` + dashboard `useQuery` gates | Every dashboard query gates on `isAuthenticated`. Because `useAuth` has a 5-minute `staleTime` but no `placeholderData`, the first paint after a hard reload is `auth/me` resolves → THEN three queries fan out → THEN charts mount and fan out their own fetches. The waterfall is serial across two round-trips before any chart sees data. | Hydrate the user from a server-rendered initial payload (the root layout already reads cookies + headers; lift the user record into a server-prop and seed `queryClient.setQueryData(["auth","me"], user)`). The dashboard's three queries then fire in the same micro-task as the page mount, removing one network round-trip from the critical path. | M |
| H4 | `src/app/api/analytics/route.ts:236` + 242-256 (correlations + health-score) | Runs three Pearson correlations and the full Personal Health Score compute on every dashboard load, even though the dashboard tile strip doesn't display the correlation cards or the health-score hero panel at first paint. Both branches fire additional Prisma reads (intake events, medications, prior-week shifted windows). | Split `/api/analytics` into two surfaces: a lightweight `/api/analytics/dashboard` that returns only the `summaries` + glucose blocks (driving the visible tiles), and `/api/analytics/insights` that carries the correlations + health-score for the `/insights` page. Or fold the correlations+health-score block under an explicit `?include=correlations` query param so the dashboard mount can skip it. | M |
| H5 | `src/components/charts/health-chart.tsx:613` (`Promise.all(types.map(...))`) | For BP, the chart fires two concurrent `/api/measurements` requests (`BLOOD_PRESSURE_SYS` + `BLOOD_PRESSURE_DIA`). Two HTTP round-trips for one logical chart. Same shape on any multi-series chart in the future. | Accept an array of types on the `/api/measurements` endpoint (`?type=BLOOD_PRESSURE_SYS,BLOOD_PRESSURE_DIA`), return rows for both types in one response. One HTTP round-trip per chart instead of N. Additive contract change, iOS unaffected. | S |

### Medium

| ID | Location | Impact | Fix shape | Effort |
|---|---|---|---|---|
| M1 | `src/app/api/analytics/route.ts:151-209` (BP-in-target chunked walk) | Runs two `fetchMeasurementSeriesChunked` calls against `BLOOD_PRESSURE_SYS` + `BLOOD_PRESSURE_DIA` with NO `since` bound — pulls the entire BP history every dashboard mount. The `computeBpInTargetWindows` helper only needs the trailing 365 days (the longest window it computes is `priorYear`). | Pass `since: oneYearAgo` to both chunked reads; `computeBpInTargetWindows` already works against the bounded set. | XS |
| M2 | `src/components/gamification/achievement-unlock-notifier.tsx:69-86` | Mounted in `AuthShell` for every authenticated user on every route. Fires `/api/gamification/achievements` every 120 s plus on every dashboard mount. The achievements endpoint returns ~20 KB on the demo. The notifier's purpose is to surface unlocks; the polling is the implementation but its cost is paid even when the user is not looking. | Replace 2-minute polling with an SSE/WebSocket or a localStorage check-on-focus pattern. Or push the refetch interval to 10 minutes — the average user does not unlock an achievement every 2 minutes. | S |
| M3 | `prisma/schema.prisma:419` (`@@index([userId, type, measuredAt])`) — present, but… | The index exists and is good for `(userId, type, measuredAt)` range queries. What is missing is a partial index on `(userId, measuredAt) WHERE type IN (BLOOD_PRESSURE_SYS, BLOOD_PRESSURE_DIA)` for the BP-in-target chunked walk, and a covering index that includes `value` so Postgres can serve the analytics aggregations as an index-only scan. Today every analytics aggregate forces a heap fetch. | Add `(userId, measuredAt) INCLUDE (type, value, source)` as a covering index, or two purpose-built indexes for the analytics aggregations. Bench against `EXPLAIN ANALYZE` before merging. | S |
| M4 | `src/components/layout/auth-shell.tsx:131` (`AchievementUnlockNotifier`) | The notifier mounts before any route-specific data lands. Its first render fires a network call that competes with the dashboard's `/api/analytics` for the same browser HTTP/2 connection's bandwidth share. | Lazy-mount via `next/dynamic` with no SSR + a 1 s mount delay. Achievements are not part of the first paint. | XS |
| M5 | `src/app/page.tsx:194-228` (three `useQuery` blocks inline) | Each block declares its own `queryFn`, no `staleTime`, no `gcTime`. Default 0 ms `staleTime` means a tab-focus-and-return triggers a refetch storm. | Lift each into a hook with `staleTime: 60_000` matching the chart query, plus `refetchOnWindowFocus: false` for analytics/widgets (they're not real-time data). | XS |

### Low

| ID | Location | Impact | Fix shape | Effort |
|---|---|---|---|---|
| L1 | `src/lib/analytics/trends.ts:200-220` | The window-mean helper allocates two filtered arrays per type for `avg30LastMonth` + `avg30LastYear`. Saved per type per request — small but adds up at ~30 types. | Single pass over the sorted series, computing all four window means with one loop. | XS |
| L2 | Per-chart `Vo2MaxChartRow`, `MoodChart`, `MedicationComplianceChart` each fire their own internal fetches even when off-screen below the fold | Initial paint pays for charts the user has to scroll to see. | Wrap below-the-fold charts in an `IntersectionObserver` so the dynamic chunk + its data fetch only fires when the chart enters viewport. The `next/dynamic` import does NOT defer the React-Query subscription. | S |
| L3 | `src/components/charts/health-chart.tsx:635-720` (`useMemo` chain) | Several `useMemo` blocks chain off the same `chartData` slice; on Recharts re-renders these all re-evaluate. The Recharts paint itself dominates, but the memo chain adds 5-10 ms per re-render on a mid-range phone. | Consolidate the memo chain into a single `useMemo` returning all derived inputs, keyed on the same dependency tuple. | XS |

## v1.4.28 gap analysis

The bounded-window work in `b00be286` is the load-bearing fix; the
pulse chart used to paginate the full measurement history on every
visit and now it does not. The 60 s `staleTime` + 5 min `gcTime` plus
the shared cache key across sub-pages collapses tab-navigation cost
to a cache hit. `ChartSkeleton` + `HealthChartDynamic` reduce the
blank-then-jolt mounting feel. The `dispatchLocalisedNotification`
LRU defends the audit-log write path.

What v1.4.28 left behind:

1. **`/api/analytics` itself.** Every C1/H1/H2/H4 finding above
   pre-dates v1.4.28 and is still true. The chart fix saved the chart,
   not the page.
2. **The `aggregate=*` server path.** Built, mock-tested, deployed,
   never invoked, currently 500s when invoked. SD-H1's client wire-up
   cannot land until C2 closes the regression.
3. **Cache-key collision in `use-chart-overlay-prefs`.** v1.4.18 vintage,
   compounds the mount waterfall.

## Pulse-specific path — volume IS the architecture

| Stage | Pulse behaviour |
|---|---|
| Chart fetch | Bounded `from`-`to` window + `limit=5000`. A 90-day window on an Apple-Watch user returns ~5 000 rows; the same window on a weight-scale user returns ~30. The bounded-window fix saved us from the unbounded historical pull; it did not save us from "today's window is still 100× larger for pulse than for weight". |
| Server `findMany` | Uses the `(userId, type, measuredAt)` index correctly. The cost is the returned row count, not the lookup. |
| Daily-bucket aggregation | Runs on the **client** in JavaScript. ~5-10 ms for 5 000 rows — wasted CPU, not the bottleneck. |
| Recharts paint | `ComposedChart` with `<Line>` series. 5 000 dots = 5 000 SVG nodes on hover. Browser layout/paint cost dominates. |

There is no in-place rewrite that makes painting 5 000 points feel
fast; the answer is to never send 5 000 points. C2 + C3 collapse the
visible series to ~365 daily-bucket rows worst case.

## Mount waterfall on `/`

```
T+0     HTML returned                                 (~127 ms TTFB)
T+~50   useAuth fires /api/auth/me                    (~110 ms)
T+~160  Fan-out, in parallel:
        /api/analytics                                (~287 ms — dominant)
        /api/dashboard/widgets                        (~111 ms)
        /api/mood/analytics                           (~105 ms)
        /api/gamification/achievements (AuthShell)    (~147 ms)
        /api/dashboard/widgets (C4 duplicate)         (~111 ms)
T+~450  Analytics resolves, tile strip paints, charts fan out their own
        /api/measurements requests
```

Critical-path latency to "tile strip painted" is `auth/me` +
`analytics` ≈ 400 ms on the demo, before any chart paints. For a
power-user the analytics leg likely doubles or triples. H3 collapses
that to one round-trip; C1 + C2 + C3 collapse the analytics leg itself.

## Index + SSR audit

Schema indexes in `prisma/schema.prisma`: `@@index([userId, type, measuredAt])`
(line 419) plus the two `@@unique` constraints support every analytics
filter correctly. Missing: a covering index that includes `value` +
`source` so analytics aggregates can serve as index-only scans (M3).

`/` is `"use client"` — no server-side data fetch on the dashboard
route. Every fetch happens after hydration, which is why H3 + C1 + C4
target the post-hydration waterfall.

## Recommendation — single-day patch + v1.5 architectural lift

**Single-day patch (ships in v1.4.29 or a v1.4.28.x point release):**

- **C2** (3 LOC + a real-Postgres integration test) — restore aggregate path.
- **C4** (4 LOC) — fix the cache-key collision.
- **C3** (10 LOC) — wire chart to pass `aggregate=daily` for windows > 7 days.
- **M5** (3 × 5 LOC) — `staleTime: 60_000` on the dashboard queries.
- **H2** (1 LOC) — bound the glucose-rows read.
- **M1** (1 LOC) — bound the BP-in-target reads.

Combined effect: pulse chart paint cost drops from 5 000 points to
~90 points per range tab, response payload drops ~50× for high-density
types, cache-key fix removes one duplicate round-trip per dashboard
mount. **Pulse chart TTFB on a power-user account: estimated 1 200 ms
→ 200 ms** (the 1 200 ms is extrapolated from C1 against a power-user
dataset; demo seed cannot expose that scale).

**v1.5 architectural lift (alongside the iOS sprint):**

- **C1 + H1 + H4** — split `/api/analytics`, move aggregations to SQL,
  rewrite `summarize()` to single-pass. ~2-3 days plus integration tests.
- **H3** — server-rendered auth seed. Removes one round-trip from
  the first-paint waterfall; touches root layout + auth flow; flag-gate.
- **M3** — covering index. Needs `EXPLAIN ANALYZE` against
  production-scale data first.
- **L2** — viewport-gated below-the-fold charts. Needs a UX call on
  the fold boundary per breakpoint.

The patch restores perceived speed; the lift removes the scaling cliff.

## Coach drawer + side-panel mounts

The dashboard does not mount the Coach drawer; `<CoachLaunchButton />`
on the insights surfaces opens it on demand. `AchievementUnlockNotifier`
is the one `AuthShell`-mounted side fetch — M2 + M4 cover its cost.

## Constraints check

Read-only audit, every finding cites file:line or measured TTFB.
Forbidden vocabulary purged. No PII — scale-words ("tens of thousands")
where the actual count matters. Aggregate path 500 confirmed against
the public demo, not the maintainer's production account.
