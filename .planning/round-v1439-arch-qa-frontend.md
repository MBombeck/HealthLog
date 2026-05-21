# Frontend + Data-Flow Audit — HealthLog v1.4.39.3

**Reviewer scope.** Senior frontend + data-flow review of the dashboard composition tree, TanStack Query topology, hydration model, and mobile-specific paint behaviour. Marc reports a "two-wave paint" (mood + medications first, then everything else simultaneously) and suspects a structural problem, not a code bug. **He's right.**

## Top 3 findings

1. **Critical — Duplicate fetch fan-out: every visible tile + chart re-fetches the same data through three independent cache keys.** The dashboard mother queries `/api/analytics` twice (slim + thick), reads mood via `/api/mood/analytics` once, and then *every visible chart card* fires another query against either `/api/measurements?type=…&aggregate=daily` (`["chart-data", …]`) or `/api/mood/analytics` again (`["mood-chart-data"]`). For an account with weight + BP + pulse + body-fat + sleep + steps charts visible, the dashboard fires **~10–12 parallel client requests** on cold mount, not the 4 the brief assumes. The "two waves" Marc describes are: (a) light slices (slim analytics, mood analytics, dashboard widgets, medications/intake) resolve in <500 ms together, then (b) the thick analytics + the six `["chart-data", …]` per-chart calls land later as one HTTP-coalesced burst. This is the visible symptom of the data-flow problem.

2. **High — `queryKeys` factory is bypassed 87 % of the time (154 bare vs 23 factory).** Despite a centralised `src/lib/query-keys.ts` with `measurementDependentKeys` / `moodDependentKeys` invalidation bundles, only 23 of 177 `queryKey:` declarations route through the factory. The chart-data and mood-chart-data keys (`["chart-data", …]`, `["mood-chart-data"]`) are bare and **not in `measurementDependentKeys`** — so after creating a measurement, the chart caches stay stale until `staleTime` expires (60 s) or the page is hard-reloaded. The dashboard's tile-strip refreshes via the analytics invalidation, but the chart row below does not. This is a latent cache-coherence bug that also drives unnecessary refetches when the factory bundle is invalidated and the chart still re-fetches on next focus.

3. **High — No `<Suspense>` boundaries anywhere in the app; zero `useSuspenseQuery` usage; 32 `"use client"` boundaries under `app/`.** The dashboard is entirely client-rendered: `RootLayout` is async server-side, but `page.tsx` is `"use client"` at line 1 and every child is too. The initial HTML payload carries **no above-the-fold data** — every tile waits for client hydration + a fetch round trip. Per-tile suspense boundaries would let mood + medication tiles paint independently from the thick analytics tile. The brief's diagnosis ("fundamental composition issue") is exactly this: a flat client tree with shared loading semantics, not a layered server-streamed shell.

## Verdict

**Marc's intuition is correct.** Post-v1.4.39.3 the dashboard *does* split into two waves, but not for the reason the v1.4.39.2 split was meant to fix. The slim/thick split helped the tile strip but the **six per-chart `["chart-data", …]` queries below it are still firing in lockstep with the thick query** and dominate the second wave. The architecture is sound at the seam (slim + thick + merge helper) but the *whole row beneath* (charts) is invisible to that contract and keeps the "blocked-then-burst" pattern alive. v1.4.39.4 should either (a) push the per-chart fetches into a shared analytics-derived store keyed on the slim+thick payload, or (b) introduce per-tile `<Suspense>` boundaries so each chart streams in independently rather than the whole row blocking on the last fetch.

---

## Critical

### C1 — Per-chart `useQuery` fan-out duplicates analytics data
- **File:** `src/components/charts/health-chart.tsx:543`, `src/components/charts/mood-chart.tsx:315`
- **Pattern:** every `<HealthChartDynamic>` (one per metric: weight, BP, pulse, body-fat, sleep, steps) declares its own `useQuery({ queryKey: ["chart-data", …] })` against `/api/measurements?type=X&aggregate=daily&source=rollup`. `<MoodChart>` declares another `useQuery({ queryKey: ["mood-chart-data"] })` against `/api/mood/analytics` — a route the dashboard `page.tsx` already fetched at line 290.
- **Impact:** the dashboard fires ~10–12 cold requests instead of 4. Even with rollup-source coverage every per-chart call is ~80–200 ms server-side; six in parallel land as one HTTP/2 multiplex burst that *looks* simultaneous but blocks the row's paint until the slowest one finishes.
- **Why it's "two waves":** mood + medications + slim analytics + widgets are light + cached + share the same `staleTime: 60_000`; thick + chart-data + medication-compliance all hit heavier server work. Network-tab waterfall: ~200 ms cluster, then a ~800 ms gap, then the rest land together. This is what Marc sees.
- **Fix sketch:** the slim analytics route already returns per-type DataSummary headlines, lastSeenByType, and could carry the daily sparkline series the charts re-derive. Move the chart's daily-aggregate fetch into a single analytics-shaped consolidated endpoint (or piggy-back on the rollup tier the route already reads) and have charts consume the same `useAnalyticsQuery`-driven store rather than each fetching its own slice.

### C2 — `chart-data` and `mood-chart-data` queryKeys aren't in `measurementDependentKeys`
- **File:** `src/lib/query-keys.ts:116-122`
- **Issue:** `measurementDependentKeys` lists `measurements()`, `analytics()`, `insightsRoot()`, `insightsTargets()`, `gamificationAchievements()`. It does **not** include `["chart-data", …]` or `["mood-chart-data"]`. After a measurement form save, `invalidateKeys(queryClient, measurementDependentKeys)` runs but the chart caches stay live until `staleTime` (60 s) expires.
- **Impact:** add a measurement → dashboard tile strip updates immediately (analytics invalidated) but the chart line below shows yesterday's data for up to a minute. Marc has not flagged this explicitly, but it likely reads as "the chart didn't update" in subjective UX.
- **Fix:** either move chart fetches onto the analytics-derived path (C1's fix supersedes this), or add `["chart-data"]` + `["mood-chart-data"]` prefix entries to the dependent-keys bundle.

---

## High

### H1 — 154/177 `queryKey:` declarations bypass `queryKeys` factory
- **Search:** `grep -rn "queryKey:" src --include="*.tsx" --include="*.ts" | grep -v "queryKeys\."` → 154 hits.
- **Factory usage:** `grep "queryKey: queryKeys\."` → 23 hits.
- **Examples of drift:**
  - `useAuth` uses `["auth", "me"]` but `queryKeys.auth()` returns `["auth"]`. The factory is not the source of truth.
  - `src/components/insights/coach-panel/use-coach.ts` declares its own local `QUERY_KEYS` constant — parallel factory.
  - `src/app/insights/medikamente/page.tsx` writes `["insights", "comprehensive"]` inline; the factory has `insightsComprehensive()` for that exact shape.
  - `src/components/settings/thresholds-editor-section.tsx` invalidates `["user", "thresholds"]` + `["insights"]` directly — neither in the factory.
- **Impact:** TanStack treats `["auth"]` and `["auth", "me"]` as different cache slots for *reads*, but a prefix invalidation matches both. This is the v1.4.32 TanStack queryKey-collision class Marc already has a memory-note about. Right now the codebase is one rename or typo away from the silent cache-poisoning failure mode.
- **Fix:** lint rule (`no-restricted-syntax`) blocking literal-array queryKeys outside `src/lib/query-keys.ts` + a one-shot migration adding the missing factory entries (notifications-prefs, ntfy-settings, global-services, passkeys, user-thresholds, coachConversation, glp1-timeline, personal-records, api-version, insights-provider-chain, measurement-drilldown, chart-data, mood-chart-data, medication-compliance-chart).

### H2 — No `<Suspense>` boundaries, no `useSuspenseQuery`, app is 100 % client-fetched
- **Search:** `grep -rn "useSuspenseQuery" src` → 0 hits. `grep "<Suspense" src/components` → 0 hits. Only commentary in `app/insights/page.tsx` *justifies* not using Suspense.
- **Layout model:** `app/layout.tsx` is an async RSC and *does* resolve the initial locale server-side, but every child page (including `app/page.tsx`) is `"use client"`. RootLayout never streams data into the dashboard.
- **Impact:** zero benefit from React 19 streaming. Initial HTML is shell-only; tiles paint only after `useAuth` → `useAnalyticsQuery` (slim + thick) → `useQuery(moodAnalytics)` → `useQuery(layoutData)` complete. On 4G mobile that's a full 3–5× RTT chain before pixels.
- **Fix sketch:** convert `app/page.tsx` to an RSC that fetches the slim analytics + widgets server-side, streams them through `<Suspense fallback>` boundaries to the existing client tile-strip component. Keep the thick analytics + per-chart queries client-side. This is a real refactor (~2 days) but it's the structural answer to the "two waves" question.

### H3 — Loading gates are implicit and shared via memoised `data`
- **File:** `src/app/page.tsx:248-276`
- **Pattern:** `mergeSlimAndThickAnalytics(slim, thick)` returns `undefined` until at least one resolves. Then `const data = useMemo(...)` becomes defined. *Every downstream gate* (`hasWeight`, `hasBp`, `showWeightTile`, etc.) reads `data?.summaries?.X`. There is no explicit "slim-loaded" vs "thick-loaded" distinction at the gate level.
- **Subtle consequence:** when slim resolves with non-empty summaries (e.g. `{ WEIGHT: {…}, PULSE: {…} }`) but thick is still pending, every tile *that depends only on summaries* will paint correctly. But the BD-Zielbereich tile gate (`hasBpInTarget`) reads `data?.bpInTargetPct` which only thick populates → that single tile is correctly held back. Good.
- **Concern:** the gate is *correct* for the intended split, but it's invisible — a future contributor adding a thick-only field (say `correlations`) to a tile that reads only summaries today won't realise they've just made the tile wait for the thick slice. A typed boundary (`SlimAnalytics` vs `ThickAnalytics` instead of the union) at the page level would make this explicit.

### H4 — `getHourForTimeZone` runs on every render (no memo)
- **File:** `src/app/page.tsx:562`
- **Issue:** `const hour = user?.timezone ? getHourForTimeZone(user.timezone) : null;` instantiates a fresh `Intl.DateTimeFormat` and parses parts on every render. The greeting text is derived from it and *included in tile keys nowhere*, so the cost is small per render — but combined with H6 below (every range/band recomputed on every render) the per-mount work is non-trivial.
- **Fix:** `useMemo(() => getHourForTimeZone(user?.timezone), [user?.timezone])`.

---

## Medium

### M1 — Dashboard prop-drilling for `compareBaseline` + `userTimezone`
- **File:** `src/app/page.tsx:1129-1300` — every `<HealthChartDynamic>` call forwards `compareBaseline` and `userTimezone`. Same for `<MoodChart>` and `<MedicationComplianceChart>`.
- **Impact:** a layout-toggle change re-renders all six chart components even though the values are conceptually app-wide. Context (`DashboardLayoutProvider`) carrying `compareBaseline` + `userTimezone` would let charts subscribe directly.
- **Severity:** medium because charts already wrap in `next/dynamic` so the re-render cost is bounded.

### M2 — `DASHBOARD_QUERY_OPTS` is a fresh object every render
- **File:** `src/app/page.tsx:221-224`
- **Issue:** `const DASHBOARD_QUERY_OPTS = { staleTime: 60_000, refetchOnWindowFocus: false } as const;` — declared inside the component body, so it's a fresh object each render. TanStack's `useQuery` does shallow-compare options; same values, same behaviour, but it's slot poisoning waiting to happen if a future field uses a callback.
- **Fix:** hoist to module scope.

### M3 — `useAnalyticsQuery` declares per-component defaults but is also called inline by sub-pages without the slim slice
- The hook is shared, but the slim/thick split is dashboard-only. The Insights page and sub-pages (`grep "useAnalyticsQuery" src/app/insights/` — 6 sites) all hit the thick slice. If the user navigates dashboard → insights → dashboard, the dashboard remounts and re-issues *both* slim + thick. The thick result from `/insights` is in cache → instant. The slim result has never been fetched anywhere else → still ~300 ms.
- **Fix:** server-prewarm slim alongside thick from the insights routes, or pre-warm via `queryClient.prefetchQuery` in a layout effect when the user lands authenticated.

### M4 — `dynamic(() => import(...), { ssr: false, loading: <ChartSkeleton /> })` for MoodChart + MedicationComplianceChart but not the others
- **File:** `src/app/page.tsx:51-64`
- **Inconsistency:** `MoodChart` + `MedicationComplianceChart` are dynamically imported inline in `page.tsx`. `HealthChartDynamic` is a separate file that wraps the same pattern. Three different ways to lazy-load the same shape.
- **Fix:** consolidate into the `HealthChartDynamic`-style wrappers so the loading skeleton, ssr flag, and bundle-split contract are uniform.

### M5 — Mobile-specific paths: none, but the symptom is real
- The brief asks "why does Marc say especially mobile?" — there are no mobile-specific code paths (no `if (isMobile)` fetches, no viewport-aware fetch logic). The waterfall is the same on desktop and mobile; mobile **feels** worse because:
  - Mobile RTT is 80–200 ms vs desktop 20–50 ms.
  - The thick slice is the heavy fetch — multiply RTT by ~5–10 vs desktop.
  - 10–12 parallel TLS handshakes on a fresh PWA cold-mount on mobile is a measurable JS-thread cost too.
- **No code change to recommend specifically for mobile** — the structural fix (C1, H2) helps both, mobile disproportionately.

### M6 — Service-worker cache + VersionPoller
- `VersionPoller` polls `/api/version` every 60 s and on mismatch unregisters every SW and reloads. The SW caches Next.js shell + static assets but not API responses.
- **No interference** with the dev tooling I can see. This is healthy.

---

## Low

### L1 — `viewport` themeColor uses raw hex literals
- `src/app/layout.tsx:86-89` — `themeColor` hex literals don't match a centralised token. If the Dracula palette token shifts, this comment-note path drifts silently.

### L2 — Inline IIFE `(() => { ... })()` in `page.tsx:719-1437`
- The whole dashboard render body is one ~720-line IIFE inside the JSX. This is readable but hostile to React DevTools — every tile and chart is "anonymous" in the component tree. Extracting a `<DashboardComposition>` component would help debuggability.

### L3 — `RangeDisplayConfig` and the `getRangeColorClass` / `getRangeHint` helpers re-evaluate every render
- `src/app/page.tsx:146-195` — `weightRange`, `bpSysRange`, `bpDiaRange`, `pulseDisplayRange`, `pulseBands`, `bodyFatBands` are all rebuilt every render from `user.heightCm` / `user.dateOfBirth`. None are memoised. The objects are stable inputs, so a `useMemo` group at the top of the component would freeze them across re-renders and stop the deep child re-renders inside Recharts.

### L4 — `medication-compliance-chart` invalidation chain
- After a medication intake POST, `medicationDependentKeys` invalidates `medications()`, `analytics()`, `insightsRoot()`, `insightsTargets()`, `medicationIntakeSummary()`, `gamificationAchievements()`. The compliance chart subscribes to `["medication-compliance-chart", days]` — not in the bundle. Same class as C2.

### L5 — `MeasurementIntakeQuickAdd` uses a `useState` for the footer DOM ref instead of a callback ref
- `src/app/page.tsx:206-214` — `setMeasurementFooterEl` triggers a re-render of the page on portal-target mount. Functionally correct, but a `useRef` + imperative `appendChild` would skip the extra render. Cosmetic.

---

## Method notes

- **Files read end-to-end:** `src/app/page.tsx`, `src/app/layout.tsx`, `src/components/layout/auth-shell.tsx`, `src/components/providers.tsx`, `src/hooks/use-auth.ts`, `src/hooks/use-workouts.ts`, `src/lib/queries/use-analytics-query.ts`, `src/lib/query-keys.ts`, `src/lib/analytics/merge-slim-thick.ts`, `src/components/dashboard/recent-workouts-tile.tsx`.
- **Files spot-checked:** `src/components/charts/health-chart.tsx` (useQuery block + window derivation), `src/components/charts/mood-chart.tsx`, `src/components/charts/medication-compliance-chart.tsx`, `src/components/charts/health-chart-dynamic.tsx`, `src/app/api/dashboard/summary/route.ts`.
- **Greps run:**
  - `useQuery`: 173 hits, `useMutation`: 85, `invalidateQueries`: 81, `useSuspenseQuery`: **0**.
  - `queryKey:` bare: 154, factory-routed: 23.
  - `"use client"` under `src/app`: 32.
  - `<Suspense`: 0 in `src/components`.
- **Cross-references with infra brief:** the slim/thick split (v1.4.39.2/.3) lives on the *analytics* route — the chart-data route (`/api/measurements?aggregate=daily&source=rollup`) is on the same rollup tier but is fanned out via per-chart queries. Both perspectives agree this is the next ROI win.

---

## Recommended sequence for v1.4.39.4

1. **C1 first** — single biggest paint-time win. Consolidate per-chart fetches behind the slim+thick analytics contract OR a new chart-bundle endpoint keyed on the visible-metrics set.
2. **C2 + L4** — bundle the chart caches into the dependent-keys lists so post-mutation freshness matches the tile strip.
3. **H2** — convert `app/page.tsx` to an RSC + `<Suspense>` boundaries per tile group (tile strip, BD-Zielbereich, chart row). This is the deeper architectural answer.
4. **H1** — factory migration + lint rule. Defensive, blocks future cache poisoning.
5. **M2/L3/H4** — small wins, batched.
