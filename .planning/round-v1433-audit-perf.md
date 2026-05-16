# v1.4.33 — Performance Audit

Scope: chart load, route navigation, Coach drawer. Production v1.4.32.
Maintainer report: charts no longer "blazing fast", next-item clicks
"unerträglich langsam", Coach drawer page "blockt komplett".
Read-only diagnosis against `develop` head.

---

## 1. Executive summary — top 3 wins ranked by ROI

| # | Win | Severity | Effort | ROI |
|---|---|---|---|---|
| 1 | Fix the `/api/analytics` queryKey/contract collision between dashboard, mother insights, sub-pages, advisor consumers, hero strip, layout shell, and the gating-helper hook. Today 7 mount sites share the literal key `["analytics"]` against one heavy route that resolves 30 chunked reads + 4 BP/correlation/health-score sub-queries each call. Two of those mount sites (`src/app/page.tsx`, `src/hooks/use-insights-analytics.ts`) declare a `staleTime`; four others (`src/app/insights/page.tsx`, `src/components/insights/sleep-overview.tsx`, `src/components/insights/insights-layout-shell.tsx`, `src/components/onboarding/getting-started-checklist.tsx`) do not. TanStack treats the first-mount wins → so the first consumer's options govern the cache cell, but every route-change re-mount sets up a new subscription tree and any consumer without `enabled: isAuthenticated` retriggers the network on a back-forward swing. Add `staleTime: 60_000`, `gcTime: 5 * 60_000`, and `refetchOnMount: false` on every consumer through a shared `useAnalyticsQuery()` helper. | Critical | S (1 file new, 7 sites edited) | Highest |
| 2 | Decompose `/api/analytics` into a fast `dashboardSummaries` slice and a thick `correlations + healthScore + bpInTarget + sleepStages` slice. The current single endpoint blocks first paint behind ~40 Postgres round-trips, every one of which is `fetchMeasurementSeriesChunked()` doing `take: 5000` cursor paging. Splitting lets `/api/analytics?slice=summaries` return the 30 per-type summaries in one or two SQL passes (`groupBy` for count/min/max/sum + a second filtered call for `slope7/30/90` window means). The thick endpoint runs separately under a longer stale window because nothing on the visible dashboard tile strip needs `correlations` or `healthScore` to paint. This IS the R-B C1 lift; the verdict in §2 below is to pull it forward into v1.4.33 because the symptoms point at it. | Critical | M (2–3 days) | High |
| 3 | Remove the cold-mount cost of `/api/insights/comprehensive` from every Insights navigation. Today `InsightsLayoutShell` issues this fetch unconditionally on every routed sub-page, and the call resolves a 90-day measurement window across 30 types, then runs four pairwise Pearson correlations + medication compliance + BP × continuity. The shell only consumes `moodSummary.count` and `medications.length` for the tab-strip availability gate. Replace the fetch with a tiny `/api/insights/availability` endpoint returning `{ hasMood, hasMedication, hasWorkouts }` (3 `COUNT(*)` queries). The mother page keeps its existing `/api/insights/comprehensive` consumer; only the layout shell drops it. | High | S (1 new route + 1 hook switch) | High |

---

## 2. R-B C1 verdict — **PULL-IN, with a scoped subset for v1.4.33**

The maintainer's three symptoms triangulate to one root cause: `/api/analytics`
is on the critical path for first paint of `src/app/page.tsx`,
`src/app/insights/page.tsx`, every routed sub-page under `src/app/insights/*`,
the Insights layout shell, and the dashboard layout query — and the route
issues ~40 Postgres round-trips per call.

### Symptom-to-cause mapping

- **Chart slowness**: a chart on `/insights/blutdruck` paints when both
  (a) the chart's own `/api/measurements?type=…&aggregate=daily` resolves AND
  (b) the page's `useInsightsAnalytics()` resolves the `["analytics"]` key for
  its empty-state gate. (b) is the long tail.
- **Next-item slowness**: route transitions inside `/insights/*` go through
  `InsightsLayoutShell` which mounts an `["analytics"]` consumer AND an
  `["insights","comprehensive"]` consumer. The shell never declares
  `staleTime` on the comprehensive one (`src/components/insights/insights-layout-shell.tsx:62-71`)
  so React Query's `defaultOptions.staleTime: 5 * 60 * 1000` from
  `src/components/providers.tsx:117` applies — that's fine in theory, BUT the
  `InsightsTabStripImpl` derives `availability` from BOTH queries and the strip
  is memo'd with `useMemo` on those fields (`insights-layout-shell.tsx:86-94`).
  When either query resolves a microtask after the other, the strip re-renders
  twice on every route change.
- **Coach drawer hang**: see §3.3 below — the Coach SSE path on the server is
  not the bottleneck. The blocking happens before the first frame ever lands
  because `requireAssistantSurface` on `/api/insights/chat` and
  `/api/insights/comprehensive` BOTH gate on a DB hit on `AppSettings` (no
  in-process cache visible from the route), and the drawer's `useCoachConversations()`
  rail call (`src/components/insights/coach-panel/use-coach.ts:51-73`) loads
  the rail on mount with `staleTime: 30 * 1000` — fine on its own, but the
  drawer's own `useCoachPrefs({ enabled: open })` (`coach-drawer.tsx:197`)
  AND the `useFeatureFlags()` call in `layout-coach-mount.tsx` AND the
  comprehensive fetch already streaming for the page produce 5+ in-flight
  fetches the moment the drawer opens. The previous patches landed in v1.4.31
  (`next/dynamic` on the drawer, `AbortController` + 8 s timeout on the advisor
  POST, memo + useMemo on the tab strip) only addressed the client-render
  cost, not the server-side gate cascade.

### Pull-in scope for v1.4.33

| Item | Cost | Risk |
|---|---|---|
| New `src/app/api/analytics/route.ts` → `dashboardSummaries` slice. Two SQL passes: (1) `prisma.measurement.groupBy({ by: ["type"], _avg, _count, _max, _min })` over the trailing 90 days for every type; (2) `prisma.$queryRaw` window-mean for `avg7` / `avg30` / `slope` per type via Postgres `regr_slope`. Drops 30 chunked reads → 2. | M (~6h) | Medium — `summarize()` slope7/30/90 currently runs against the full series; the SQL `regr_slope` returns the same statistic and a Postgres EXPLAIN ought to confirm the index path. The existing per-type chunked walks still exist for `bpInTargetWindows` + correlations, so the slope semantic is the only thing under review. |
| New `src/app/api/insights/availability/route.ts`. Three `COUNT(*)` queries on `Measurement`, `MoodEntry`, `Medication`. Layout shell consumes this instead of `/api/insights/comprehensive`. | S (~1.5h) | Low — net-new endpoint, no contract break. |
| Shared `useAnalyticsQuery()` hook in `src/hooks/use-analytics-query.ts` collapsing the 7 mount sites onto one definition with `staleTime: 60_000`, `refetchOnMount: false`. | S (~2h) | Low — type-checked surgery. |
| `/api/analytics` thick slice (`?slice=full` or default) keeps its current shape. Gate it behind a hover prefetch on the Coach drawer + the correlation row's `<InView>` boundary. | S (~1h) | Low. |
| Drop the duplicate `["analytics"]` literal across `src/app/insights/page.tsx`, `src/components/insights/sleep-overview.tsx`, `src/components/onboarding/getting-started-checklist.tsx`. Switch to `queryKeys.analytics()`. | S (~1h) | Low. |

**Total effort**: 1.5 days of focused work. Fits inside v1.4.33's
"polishing patch" envelope; defer the more exotic correlation-side SQL
rewrites to v1.4.34 or v1.5.x.

**Sequence**: A1 queryKey collapse → A2 availability endpoint → A3 dashboard
slice rewrite → A4 prefetch wiring. A1 is safe to ship alone if the
slice rewrite uncovers an issue under load.

**Why not defer to v1.5.x**: the strategic-plan §4 row "Lands in v1.5.x if
not folded into Day 1-2 server prep" pre-dated the maintainer's
"alles träge geworden" complaint. Three symptom vectors converge on this
endpoint; deferring it past v1.4.33 means shipping another polishing
patch that the user perceives as slow.

---

## 3. Per-symptom diagnosis

### 3.1 Chart load slowness

**Where time goes**:

1. **`/api/analytics` parallel fan-out** — `src/app/api/analytics/route.ts:61-116`.
   30 `Promise.all`'d `fetchMeasurementSeriesChunked()` calls. For a user
   with multi-year HealthKit history each cumulative type pages through
   `MEASUREMENT_CHUNK_SIZE = 5000` rows; pulse paging is the dominant cost.
   The chunked walk is then handed to `summarize()` which sorts the full
   array twice (once in `summarize`, once in `trendSlope` per window) and
   filters three additional time slices for `slope7/30/90`. Reading
   30 × N rows when 30 daily aggregates would suffice.

2. **Same key, different consumers** — `src/app/insights/page.tsx:138`
   declares `queryKey: ["analytics"]` with no `staleTime`; the layout shell
   above it (`src/components/insights/insights-layout-shell.tsx:48-57`)
   declares the same key with `staleTime: 60_000`. The shell's mount-order
   is earlier in the render tree, so its options win — but the mother
   page's consumer still establishes a fresh subscription, and any
   downstream consumer that lacks `enabled: isAuthenticated` re-issues
   the network on a back-navigation swing. `src/hooks/use-insights-analytics.ts:57-67`
   does declare `staleTime: 60_000`, so the sub-pages are OK; the mother
   page is not.

3. **Chart fetches are good**, paradoxically. The C3 fix from v1.4.29
   landed; `aggregate=daily` is wired on windows > 7 days
   (`src/components/charts/health-chart.tsx:588-590`). The chart's own
   `useQuery` has `staleTime: 60_000` + `gcTime: 5 * 60_000`
   (`health-chart.tsx:563-564`). The slow piece is the gating fetch that
   runs alongside the chart fetch, not the chart fetch itself.

**File:line references**:
- `src/app/api/analytics/route.ts:46-116` (30-type fan-out)
- `src/app/api/analytics/route.ts:194-201` (BP-in-target 2 more chunked walks)
- `src/app/api/analytics/route.ts:391-403` (correlation 5 reads)
- `src/app/api/analytics/route.ts:746-791` (health-score 4 more reads)
- `src/lib/analytics/trends.ts:171-247` (summarize sorts + 4 window filters per metric)

**Proposed fix**: split the route per §2. The dashboard `summaries`
slice resolves with 2 SQL passes; the thick slice resolves lazily.
Charts paint when their own slim fetch resolves — no longer gated on
the dashboard summaries' tail.

### 3.2 Navigation slowness

**Where time goes**:

1. **`InsightsLayoutShell` triple-fetch on every routed mount** —
   `src/components/insights/insights-layout-shell.tsx:42-95`. The shell
   mounts `useInsightsAdvisorQuery`, `["analytics"]`, `["insights", "comprehensive"]`,
   and `useWorkouts({ limit: 1 })`. Three of the four issue network calls
   on cold cache; the comprehensive call is the heaviest. The shell lives
   in `src/app/insights/layout.tsx` so it persists across sub-page routes,
   but a hard refresh or a back-then-forward navigation tears the layout
   down and rebuilds it — the four queries refire.

2. **`availability` prop recompute** — the shell's `useMemo` at
   `insights-layout-shell.tsx:91-94` is keyed on `(isAuthenticated, summaries,
   hasMood, hasMedication, hasWorkouts)`. The first three derive from
   `analyticsQuery.data?.summaries` and `comprehensiveQuery.data?.moodSummary.count`,
   neither of which has a stable reference even after the data lands —
   every cache write produces a new object. The memo therefore recomputes
   on every cache write while the queries are settling. The `React.memo`
   on `InsightsTabStripImpl` (`insights-tab-strip.tsx:284`) only catches
   identical-reference props; the recomputed `availability` cascades
   through it.

3. **The hero strip + briefing + correlation row + trends row all live on
   the mother page**, NOT the layout. Navigating from `/insights` to
   `/insights/blutdruck` unmounts every component except the strip; the
   sub-page then mounts its own `useInsightsAnalytics()` consumer (cache
   hit, fast) AND its own `useInsightStatus(metric)` consumer (cold,
   fires `/api/insights/blood-pressure-status` etc.). Each status endpoint
   does its own assistant-surface gate + provider chain check.

4. **Coach drawer staying mounted** — confirmed not the source of
   navigation slowness, per `src/app/insights/layout.tsx:31-39`. The
   drawer mounts via `next/dynamic` and is only torn down when the entire
   layout unmounts.

**File:line references**:
- `src/components/insights/insights-layout-shell.tsx:42-95`
- `src/components/insights/use-insights-advisor.ts:149-160`
- `src/hooks/use-feature-flags.ts:79-90` (every Insights page reads this; soft-fail OK)
- `src/app/api/insights/*-status/route.ts` (per-metric status routes; ~6 endpoints)

**Proposed fix**:
1. Replace `comprehensiveQuery` in the layout shell with a 3-column
   `/api/insights/availability` endpoint that returns `{ hasMood, hasMedication,
   hasWorkouts }`. Three `COUNT(*)` queries vs the current 90-day fan-out
   over 30 measurement types + mood + medications + intake events.
2. Stabilise the `availability` prop reference — the underlying scalars
   can drive `useMemo` directly. Drop `summaries` from the dep array if
   the helper `hasMetricData()` only reads `summaries[metric].count`; pre-derive
   a `metricsWithData: Set<MeasurementType>` and memo on the set's
   serialised shape instead.
3. Prefetch the next-likely sub-page's `useInsightStatus` on hover/focus
   of the tab strip pill so the click→paint window is dominated by the
   route transition, not the network. Wire via `queryClient.prefetchQuery`
   inside the `<Link>` `onMouseEnter` handler (use `next/link` `prefetch`
   for the route bundle; React-Query for the data).

### 3.3 Coach drawer hang

**What happens on first Coach navigation**:

1. **Drawer mounts but no fetches fire yet** — `next/dynamic` boundary
   in `src/components/insights/layout-coach-mount.tsx:18-24` defers the
   subtree until the user opens the drawer. The mount itself is cheap.

2. **Drawer opens — five fetches kick off in parallel**:
   - `useCoachConversations()` → `GET /api/insights/chat` (rail list).
     Gates on `requireAssistantSurface("coach")` server-side.
     `src/components/insights/coach-panel/use-coach.ts:51-73`.
   - `useCoachPrefs({ enabled: open })` → `GET /api/auth/me/coach-prefs`.
     `coach-drawer.tsx:197`.
   - `useFeatureFlags()` → `GET /api/feature-flags` if the cache is cold.
     `layout-coach-mount.tsx:38`.
   - `useCoachConversation(id)` does NOT fire until the user picks a row
     in the rail — fine.
   - The mother page's existing `/api/insights/comprehensive` consumer
     may still be in-flight if the user opened the drawer within ~1 s
     of landing on `/insights`.

3. **Server-side gate cascade**: `requireAssistantSurface("coach")` is
   imported from `@/lib/feature-flags`. Every Coach + insights route
   that's gated hits the same `AppSettings` row. If the implementation
   reads the row per call (no in-process or per-request memo), the
   gate is fast but not free; with five fetches kicking off
   simultaneously the connection pool sees 5 sequential `SELECT` against
   the same row.

4. **First message send** — `useSendCoachMessage.send()` POSTs to
   `/api/insights/chat`. The route then:
   - `requireAuth()` — DB hit on session.
   - `requireAssistantSurface("coach")` — DB hit.
   - `enforceBudget(userId)` — DB hit on `CoachUsage`.
   - `prisma.user.findUnique({ … coachPrefsJson })` — DB hit.
   - `buildCoachSnapshot(userId, scope)` — heaviest call.
     `src/lib/ai/coach/snapshot.ts` runs `extractFeatures()` from
     `src/lib/insights/features.ts` which itself walks `prisma.measurement.findMany`
     across the same 30 types over a 30/90-day window. ~10 DB calls.
   - Provider chain runs the LLM call (network, not DB).

5. **The "blockt komplett" symptom**: the first paint of the drawer
   renders the empty-thread state immediately — that part works. The
   block is between "user clicks send" and "first SSE `token` frame
   arrives". The five fetches in step 2 above plus the snapshot build
   in step 4 plus the LLM provider chain itself are all serial within
   the request lifecycle. The provider chain is the dominant 2–8 s tail,
   but the snapshot build adds 200–800 ms on top.

**File:line references**:
- `src/components/insights/coach-panel/use-coach.ts:278-493` (send hook)
- `src/app/api/insights/chat/route.ts:129-298` (handler)
- `src/lib/ai/coach/snapshot.ts:1-120` (snapshot builder)
- `src/lib/insights/features.ts:283-720` (feature extractor — 4× findMany)
- `src/lib/feature-flags.ts` (gate read on every gated route)

**Proposed fix**:
1. **Cache the snapshot per `(userId, scope)` for 60 seconds**. The
   snapshot reads only persisted data; within a single conversation a
   user sends 2–4 turns in quick succession and the snapshot is
   recomputed each time. A simple in-memory LRU keyed on
   `${userId}:${scope.window}:${scope.sources.join(",")}` saves ~500 ms
   per turn after the first.
2. **Memoise `requireAssistantSurface`** per request. The settings row
   doesn't flip mid-request; one read at the start of the request
   shared across every gate call.
3. **Defer the rail list fetch** until the user opens the history tray.
   The drawer's first paint doesn't need the rail — it shows the empty
   thread on the right column. Move `useCoachConversations(open)` to
   `useCoachConversations(historyTrayOpen || isDesktopRailVisible)`. The
   desktop rail mount needs the data on open; the mobile path can defer.
4. **Pre-warm `/api/feature-flags`** at root layout level so the Coach
   open never waits on a cold flag fetch.

---

## 4. Punch list — ordered by ROI

| Order | Item | Severity | Effort | File scope | Notes |
|---|---|---|---|---|---|
| 1 | Collapse the seven `["analytics"]` mount sites onto a single `useAnalyticsQuery()` hook with `staleTime: 60_000`, `gcTime: 5 * 60_000`, `refetchOnMount: false`. | Critical | S (~2h) | `src/hooks/use-analytics-query.ts` (new); edits to `src/app/page.tsx:205-215`, `src/app/insights/page.tsx:137-146`, `src/components/insights/sleep-overview.tsx:71`, `src/components/insights/insights-layout-shell.tsx:48-57`, `src/components/onboarding/getting-started-checklist.tsx:196`, `src/hooks/use-insights-analytics.ts:57-67` | Pure refactor; no contract change. |
| 2 | Add `src/app/api/insights/availability/route.ts` returning `{ hasMood, hasMedication, hasWorkouts }`. Swap the layout shell's `comprehensiveQuery` for the new hook. | Critical | S (~2h) | new route + `src/components/insights/insights-layout-shell.tsx:62-94` | Drops ~10 DB calls per Insights mount. Net-new endpoint, no breakage. |
| 3 | Pull-in R-B C1 (scoped) — `/api/analytics?slice=summaries` SQL-side. Replace 30-type chunked fan-out with `groupBy` + window-mean SQL. | Critical | M (~6h) | `src/app/api/analytics/route.ts:32-293` | Slope semantic preserved via Postgres `regr_slope` over the per-window filter; integration test pins identity against the existing chunked path output. |
| 4 | Per-request memo of `requireAssistantSurface()`. Single `AppSettings` read shared across every gate inside one request. | High | S (~1h) | `src/lib/feature-flags.ts` | Use the existing `annotate()` request-context pattern as the carrier. |
| 5 | 60-second LRU on `buildCoachSnapshot()` keyed on `(userId, scope)`. | High | S (~2h) | `src/lib/ai/coach/snapshot.ts` | LRU shape: `new Map<string, { result, expires }>` with hand-rolled 16-entry cap; the route already lives behind auth so trust-boundary is per-process. |
| 6 | Stabilise `availability` prop in `InsightsLayoutShell`. Derive a `metricsWithData: ReadonlyArray<MeasurementType>` from `summaries`, memo on the sorted-join string. | High | S (~1h) | `src/components/insights/insights-layout-shell.tsx:86-94`, `src/lib/insights/metric-availability.ts` | Stops the strip re-render cascade on every cache write. |
| 7 | Defer the Coach rail list fetch (`useCoachConversations`) until the history tray opens OR the desktop rail mounts visible. | High | S (~1h) | `src/components/insights/coach-panel/history-rail.tsx`, `src/components/insights/coach-panel/coach-drawer.tsx:438-444, 510-518` | The desktop layout-shell mount needs the data immediately; the mobile path defers. Use `useIsMobile()` to gate. |
| 8 | Replace literal `["analytics"]` invalidation keys with `queryKeys.analytics()` in mutation handlers. | Medium | XS (~30 min) | `src/components/settings/thresholds-editor-section.tsx:90, 110`, `src/components/targets/target-edit-sheet.tsx:219, 251` | Defensive cleanup; the typo class is exactly what `queryKeys` exists to prevent. |
| 9 | Pre-warm `/api/feature-flags` at root layout. Issue the fetch once at mount; every consumer reads from cache. | Medium | XS (~30 min) | `src/components/providers.tsx`, root layout | Soft-fail path stays intact; cache pre-warmed on cold mount. |
| 10 | Add a hover/focus prefetch on `<InsightsTabStrip>` pills for `useInsightStatus(metric)`. Optional — drops the click→paint window on sub-page transitions. | Medium | S (~1.5h) | `src/components/insights/insights-tab-strip.tsx:201-220` | Use `queryClient.prefetchQuery` inside the `<Link>` `onPointerEnter`. |
| 11 | Move `pulseRows` correlation read to a Postgres `LATERAL` pair of `regr_slope` calls instead of the chunked walk. | Low | M (~4h) | `src/app/api/analytics/route.ts:391-518` | Belongs to the v1.4.34 C1 follow-up if v1.4.33 only lands the summaries slice. |
| 12 | Drop `gcTime` defaults at provider level to `15 * 60_000` for the analytics + insights tree. Long inactivity should evict the multi-megabyte payload. | Low | XS (~15 min) | `src/components/providers.tsx:112-124` | Memory hygiene, not perf-critical. |

---

## 5. What was already done in v1.4.31 + v1.4.29 (and why it wasn't enough)

The strategic plan §2 v1.4.31 ships three client-side Coach fixes per
`.planning/research/v15-insights-blocking-bug.md`:

1. `AbortController` + 8 s timeout on `fetchAdvisor` —
   `src/components/insights/use-insights-advisor.ts:63-90`.
2. `React.memo` + `useMemo` on the tab strip —
   `src/components/insights/insights-tab-strip.tsx:284`,
   `src/components/insights/insights-layout-shell.tsx:91-94`.
3. `next/dynamic` for `<CoachDrawer>` —
   `src/components/insights/layout-coach-mount.tsx:18-24`.

v1.4.29 shipped `staleTime: 60_000` on the three inline dashboard queries
plus `refetchOnWindowFocus: false` — `src/app/page.tsx:200-203` —
which is good, but those changes only cover the dashboard's own
`useQuery` blocks. The Insights mount tree was never normalised.

The remaining blocking is server-side: every Coach turn rebuilds the
snapshot, every Insights mount fans out 30 chunked reads through
`/api/analytics`, and every gated route reads `AppSettings` from cold.
The three v1.4.31 fixes addressed the WebKit-tap-gesture mobile path;
the desktop "alles träge" experience is the unaddressed remainder.

---

## 6. Open questions for the maintainer

1. **Is the `regr_slope` semantic acceptable** for the summaries slice
   replacement? Postgres' `regr_slope(value, EXTRACT(EPOCH FROM measured_at))`
   returns the slope in value-per-second; the existing `summarize()`
   returns value-per-day with an R² confidence. The R² is rendered on
   tile callouts but only as a "stable / up / down" three-way; the SQL
   side can produce both numbers in one pass.
2. **Are slopes per window (7 / 30 / 90 d) all consumed**, or is
   `slope30` the only one any tile actually reads? Auditing the
   `summarize()` callers will tell us whether the SQL replacement can
   resolve a single slope per type instead of three.
3. **Does the Coach drawer ever read `useCoachConversations()` on cold
   mount BEFORE the user opens the history tray** on a desktop viewport?
   `src/components/insights/coach-panel/history-rail.tsx` consumes the
   hook unconditionally — confirm whether the desktop rail's visible
   mount paints the rail content from cold or whether deferring is
   safe even there.
