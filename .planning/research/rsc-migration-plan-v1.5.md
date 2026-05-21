# RSC Migration Plan — `app/page.tsx` (HealthLog v1.5)

**Author:** W-RSC-RESEARCH (HealthLog v1.4.41 marathon)
**Status:** Research only — no source code changes
**Target release:** v1.5 minor (dedicated 2–3 day marathon, no parallel waves)
**Inputs:**
- `.planning/round-v1439-arch-qa-frontend.md` (frontend audit, Critical/High findings C1/C2/H2/H3/H4)
- `.planning/phase-W-RSC-v1440-report.md` (Suspense layer + queryKey factory shipped)
- `src/app/page.tsx` (1 495 lines, `"use client"` line 1)
- `src/app/layout.tsx` (already async RSC — locale + nonce resolve server-side)
- 30 sibling `"use client"` files under `src/app/` (samples: `insights/page.tsx`, `measurements/page.tsx`)

---

## 1. Current state inventory

### 1.1 Why `app/page.tsx` is `"use client"` today

Hook surface that pins client-side rendering:

| Hook / API | Site | Purpose |
| --- | --- | --- |
| `useAuth()` | line 208 | session + `user` profile (timezone, dateOfBirth, gender, heightCm, glucoseUnit) |
| `useTranslations()` / `useFormatters()` | 209–210 | i18n context (locale-aware number/date formatting) |
| `useState<…>` × 4 | 211–224 | quick-entry sheet state + 3 footer-portal DOM refs |
| `useAnalyticsQuery({ slice: "summaries" })` | 255 | **slim** analytics fetch (per-type DataSummary headlines) |
| `useAnalyticsQuery()` | 256 | **thick** analytics fetch (`bpInTargetPct*`, `glucoseByContext`) |
| `useMemo` (merge slim+thick) | 257–285 | `mergeSlimAndThickAnalytics(slim, thick)` |
| `useQuery(queryKeys.dashboardWidgets())` | 287 | layout (visibility + order of every widget) |
| `useQuery(queryKeys.moodAnalytics())` | 299 | mood summary + sparkline series |
| `useMemo` (hour-of-day) | 577–580 | greeting copy keyed on `user.timezone` |

Plus interactive primitives: `<DropdownMenu>`, `<ResponsiveSheet>`, `<MeasurementForm>`, `<MoodForm>`, `<MedicationIntakeQuickAdd>`, `<TourLauncher>`.

Plus per-tile `<Suspense fallback>` boundaries (shipped v1.4.40 W-RSC) — already streaming-ready.

### 1.2 Data fetched from the page

- **Slim analytics** (`/api/analytics?slice=summaries`) — fast path; rollup-served, < 1 s warm.
- **Thick analytics** (`/api/analytics`) — full fan-out; carries `bpInTargetPct*` + `glucoseByContext`.
- **Dashboard widgets** (`/api/dashboard/widgets`) — layout config (per-user).
- **Mood analytics** (`/api/mood/analytics`) — mood summary + sparkline entries.

Both `useAnalyticsQuery` calls share `caches.analytics` server-side; warm hits are free.

### 1.3 Client-only patterns blocking RSC migration

1. **TanStack Query everywhere** — `useQuery` × 4 on the page, plus every chart child re-fetches via `["chart-data", …]` / `["mood-chart-data"]`. RSC cannot host `useQuery`.
2. **`useState` for sheet open/close + footer portal refs** — interactive UI state.
3. **`useAuth()` is a client hook** (reads from a TanStack-Query-backed `["auth","me"]` slot). The session itself can be resolved server-side via the existing session helper that `app/layout.tsx` already uses for headers/cookies.
4. **`useTranslations()` + `useFormatters()` are client-side** — bound to a Providers tree-internal context. RSC i18n requires a parallel server-side `t()` reader.
5. **Inline IIFE in the JSX (`(() => { … })()` lines 737–1492)** — ~755 lines of tile/chart assembly; not a hook problem but every conditional reads from client-only `data` / `user` / `layout`.
6. **30 sibling `"use client"` pages** — same patterns at smaller scale. RSC migration of `page.tsx` is the lighthouse; siblings stay client unless promoted in later releases.

### 1.4 Already in place (do not re-do)

- `<Suspense fallback={<ChartSkeleton/>}>` per chart row + `<Suspense fallback={null}>` per tile-strip cell (v1.4.40 W-RSC).
- `queryKeys` factory routing for dashboard + chart hooks; `measurementDependentKeys` bundles `["chart-data"]` + `["dashboard-medication-compliance"]` prefixes (v1.4.40 W-RSC).
- `DASHBOARD_QUERY_OPTS` module-scope hoist; `getHourForTimeZone` memoised (v1.4.40 W-RSC audit-M2 + audit-H4).
- `RootLayout` is already async RSC — reads `headers()`/`cookies()` for locale + CSP nonce.

---

## 2. Target architecture

```
app/page.tsx                                 (Server Component, async)
├── resolveSession(cookies/headers)          → user (RSC-safe helper)
├── cache() wrapper:
│   ├── getSlimAnalyticsForUser(userId)      → /api/analytics slim equivalent
│   └── getDashboardWidgetsForUser(userId)   → /api/dashboard/widgets equivalent
└── <DashboardShell user, locale, layout, slim>     (server)
    ├── <PageHeader t, user, greeting>              (server — static)
    ├── <QuickAddTrigger>                           (client island)
    │     ├── <DropdownMenu …>
    │     └── <ResponsiveSheet …> × 3
    ├── <GettingStartedChecklist>                   (already self-gated client)
    ├── <TourLauncher ready>                        (client; ready computed from server hint)
    ├── <Suspense fallback={<TileStripSkeleton/>}>
    │     └── <TileStripServer user, slim>          (server — renders TrendCard per tile)
    │           └── <TrendCard …/>                  (server — pure presentational, no hooks)
    ├── <Suspense fallback={<TileSkeleton/>}>
    │     └── <BdZielbereichTile slim, thickPromise/> (streams thick via async server child)
    ├── <Suspense fallback={<TileSkeleton/>}>
    │     └── <GlucoseTilesServer thickPromise/>      (streams thick)
    └── <ChartRowServer layout, user>                (server — composes the chart row)
          ├── <Suspense fallback={<ChartSkeleton/>}>
          │     └── <WeightChartClient>             (client — Recharts; reads chart-data via TanStack)
          ├── <Suspense fallback={<ChartSkeleton/>}>
          │     └── <BpChartClient>                  (client)
          └── … (one Suspense + client island per chart)
```

Key contracts:

- **Server Components** carry the static shell, the per-request slim+thick fetch, the TrendCard tiles (pure presentational), and the chart-row scaffolding.
- **`<Suspense>`** boundaries (already shipped) wrap each data-dependent island. Each one streams independently.
- **Client islands**: `<QuickAddTrigger>` (dropdown + sheets + forms), every chart (Recharts is client-only — no SSR), the tour launcher, the getting-started checklist.
- **`cache()`** wraps slim + widgets fetchers so a single React tree render only hits the DB once per request even if multiple server children read them. Use `unstable_noStore()` (or `export const dynamic = "force-dynamic"`) so per-request freshness wins over the route-segment cache.
- **TanStack Query stays** for client islands (chart-data, mood-chart-data, optimistic mutations, focus refetch). The dashboard page itself no longer hosts a `QueryClient` read of slim/thick analytics — those are server data passed in as props.

---

## 3. Chunked migration steps

Each step is shippable independently. Each step ends with a CI run + a manual deploy probe.

### Step 1 — Carve out the static shell as a Server Component wrapper

- **Goal:** `app/page.tsx` becomes a server component that renders the existing dashboard as a child client component. No data moves yet.
- **Touched files:**
  - `src/app/page.tsx` (new — server) — `export const dynamic = "force-dynamic"`, resolves `user` via the same session helper `layout.tsx` uses, renders `<DashboardClient user={user} />`.
  - `src/app/dashboard-client.tsx` (new — `"use client"`) — receives `user` as a prop, contains today's entire `DashboardPage()` body.
- **Risk:** low. Behaviour-identical refactor; `useAuth()` is replaced inside the client with `user` prop + a thin client-side cache hydrate (so client islands deeper in the tree still see `useAuth().user`).
- **Tests:** dashboard render snapshot, auth-prop hydration test, e2e dashboard.spec.ts.
- **Acceptance:** page renders byte-identical; `Application` tab shows no "use client" boundary at the route root.

### Step 2 — Move slim analytics + widgets fetch to the Server Component

- **Goal:** server fetches slim analytics + widgets, passes them as props; the client only fetches the thick slice.
- **Touched files:**
  - `src/lib/analytics/server-fetchers.ts` (new) — `getSlimAnalytics(userId)` + `getDashboardWidgets(userId)`, both wrapped in React `cache()`.
  - `src/app/page.tsx` — calls both fetchers, passes `slim` + `layout` as props.
  - `src/app/dashboard-client.tsx` — replaces `useAnalyticsQuery({ slice: "summaries" })` + the `dashboardWidgets()` `useQuery` with prop reads. Keeps the thick `useAnalyticsQuery()` client-side.
  - Optional: hydrate the TanStack cache with the server-fetched slim payload so client-side mutations + invalidations still reach the right slot (`hydrate({ queries: [...] })`).
- **Risk:** medium. The slim fetcher must mint the same `lastSeenByType` + `summaries` shape the route currently returns. Use the existing internal function (don't re-implement) — `/api/analytics?slice=summaries` calls into a service layer; lift that service layer into `server-fetchers.ts`.
- **Tests:** parity test (server fetch result == HTTP route result), updated dashboard render snapshot, mutation-invalidation test (after `POST /measurements` the dashboard refetches via TanStack invalidation OR the page revalidates via `revalidatePath("/")`).
- **Acceptance:** Network tab on cold mount shows one fewer client-side request; tile strip paints with the initial HTML.

### Step 3 — Thick analytics streaming via `<Suspense>` + nested Server Component

- **Goal:** the BD-Zielbereich tile + glucose-tiles + the row's deeper-thick consumers move into an async server child wrapped in `<Suspense>`. Initial HTML carries slim data + tile-strip skeleton for the thick-dependent tiles; the thick slice streams in as the second flush of the streaming response.
- **Touched files:**
  - `src/components/dashboard/bp-in-target-tile-server.tsx` (new) — async RSC, awaits a `thickPromise` passed from the parent.
  - `src/components/dashboard/glucose-tiles-server.tsx` (new) — same shape.
  - `src/app/page.tsx` — kicks off `getThickAnalytics(userId)` (also `cache()`-wrapped) WITHOUT awaiting it; passes the promise down to the suspending children.
- **Risk:** high. Streaming requires the response to NOT be buffered by any reverse proxy. Coolify's Caddy-reverse-proxy default config buffers `text/html` responses by default — a prerequisite check is mandatory (§4.1).
- **Tests:** streaming probe (assert HTTP response body arrives in ≥ 2 flushes); per-tile suspense boundary unit test extended.
- **Acceptance:** BD-Zielbereich tile renders ~500 ms after the tile-strip in the network waterfall.

### Step 4 — Each tile becomes its own Server Component island

- **Goal:** the inline IIFE (lines 737–1492) is dissolved. Every tile is a self-contained server (or client, if interactive) component. The page assembles them via the layout-order array.
- **Touched files:**
  - `src/components/dashboard/tiles/weight-tile.tsx`
  - `src/components/dashboard/tiles/bp-sys-tile.tsx`
  - `src/components/dashboard/tiles/bp-dia-tile.tsx`
  - `src/components/dashboard/tiles/pulse-tile.tsx`
  - `src/components/dashboard/tiles/body-fat-tile.tsx`
  - `src/components/dashboard/tiles/mood-tile.tsx`
  - `src/components/dashboard/tiles/sleep-tile.tsx`
  - `src/components/dashboard/tiles/steps-tile.tsx`
  - `src/components/dashboard/tiles/vo2-tile.tsx`
  - `src/components/dashboard/tiles/glucose-tiles.tsx`
  - `src/components/dashboard/tile-strip.tsx` (new — server, assembles tiles from layout order)
- **Risk:** medium. `getRangeColorClass` / `getRangeHint` / `tileCompareDelta` / `tileStaleDays` helpers move into per-tile files OR a shared server-safe helper module. Range / band derivation helpers (already pure) move to `src/lib/analytics/value-bands.ts` consumers cleanly.
- **Tests:** one render test per tile + the existing dashboard-suspense-boundaries.test.ts updated.
- **Acceptance:** React DevTools shows named components per tile (cf. audit L2). Initial HTML carries one tile's static frame per cell.

### Step 5 — Trim client islands to interactive pieces only

- **Goal:** every component that does NOT use a hook drops `"use client"`. Identify candidates: `TrendCard`, `TrendHint`, `EmptyState`, the page-header block, the welcome banner, the `<GettingStartedChecklist>` static frame (the dismiss button stays a client child).
- **Touched files:** ~15–20 component files, mostly removing the directive at line 1.
- **Risk:** low. Each removal is a one-line edit gated by typecheck + test. If a component transitively imports a client-only API (e.g. `next/dynamic`), it stays client.
- **Tests:** all existing tests stay green; bundle-analyzer probe confirms the dashboard route's client JS payload shrinks.
- **Acceptance:** bundle-analyzer report: route `/` client JS ≤ 60 % of pre-migration size (rough target — verify against actual numbers in step).

---

## 4. Prerequisites

### 4.1 Next.js streaming verification — Coolify proxy buffering

- **Risk:** Caddy's `reverse_proxy` directive (Coolify's default) does NOT buffer by default for HTTP/1.1, BUT `flush_interval` defaults can collapse short flushes. Verify by deploying a one-route probe to staging and `curl --no-buffer -N https://staging/probe-stream` — assert chunks arrive ≥ 100 ms apart.
- **Mitigation:** if buffering is observed, set `flush_interval: -1` (immediate flush) on the dashboard route in the Caddy snippet. Document in `docs/infra/coolify-config.md`.
- **Owner:** infra wave; must complete BEFORE Step 3.

### 4.2 Test fixture updates

- **Vitest dashboard tests** today mount `DashboardPage` directly inside a `QueryClientProvider`. Step-1 split requires either:
  - rendering `DashboardClient` directly (cleanest — tests already supply `user` via mocked `useAuth`), OR
  - introducing a `<TestServerWrapper>` that simulates the RSC prop-injection.
- **Playwright e2e** (`tests/e2e/dashboard.spec.ts`) — no changes needed for Step 1; for Step 3 (streaming) extend with an `await page.waitForResponse` that asserts ≥ 2 chunks for the dashboard route.
- **Snapshot tests** — every dashboard snapshot regenerates once per step. Treat as expected churn.

### 4.3 React Compiler compatibility

- React Compiler is enabled in `next.config.js` (verify before Step 1). The compiler runs on client components; promoting components to server components removes them from the compiler's surface area (server components are not memoised by the compiler). No regression — but the bundle-analyzer comparison in Step 5 must compare apples-to-apples (post-compiler client bundle vs post-compiler client bundle).
- **Owner:** prerequisite verification in Step 1; if the compiler is NOT enabled the plan is unchanged.

### 4.4 Session helper RSC-safety

- `useAuth()` is client. The server-side equivalent is a `getCurrentUser()` helper that reads the JWT/session cookie via `cookies()`. Audit `src/lib/auth/` for an existing helper; if absent, factor one out of the API-route session middleware as the first sub-step of Step 1.

### 4.5 i18n server-side reader

- `useTranslations()` is a client hook. RSC pages need a server-side `t(locale, key)` reader that loads the same message bundle. The locale already resolves server-side in `layout.tsx` (`resolveInitialLocale`); reuse the same bundle loader.
- **Owner:** prerequisite for Step 1's static header / welcome banner. If the bundle loader is client-only today, factor an `import { getServerTranslations } from "@/lib/i18n/server"` out of the existing `Providers` tree.

### 4.6 `cache()` + bounded TTL

- React `cache()` dedupes within a single render. For request-level dedupe across multiple `await`s in the same render, that is exactly what's needed.
- For cross-request reuse (avoiding hitting the DB twice in two consecutive requests within ~1 minute), wrap the inner fetchers in `unstable_cache(fn, key, { revalidate: 60 })`. Verify the staleness window matches today's `DASHBOARD_QUERY_OPTS.staleTime: 60_000`.
- After a measurement / mood / medication-intake mutation, the relevant API route must call `revalidateTag("user:<id>:analytics")` (set the tag on the `unstable_cache` wrap). Otherwise the dashboard reads stale slim data for up to 60 s after a save.

---

## 5. Risk register

| ID | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | **Hydration mismatch on initial mount** — server-rendered tile values vs client-side TanStack-cache-derived values diverge on prop hydrate | **High** | Hydrate the TanStack QueryClient with the server payload at the boundary (`<HydrationBoundary state={dehydrate(qc)}>`). One mount-time assertion per tile in tests. |
| R2 | **Performance regression** — server compute path heavier than the client cache-warm hit it replaces | High | Step-2 bench gate: compare TTFB + LCP against pre-migration baseline; reject if LCP degrades > 100 ms. Server slim fetch must hit the rollup tier (already `< 100 ms` warm). |
| R3 | **SSR data freshness** — `cache()` + `unstable_cache` TTL drifts from TanStack staleTime | Medium | Pin TTL = 60 s in both layers; mutations call `revalidateTag(...)` AND `queryClient.invalidateQueries()`. Single integration test asserts post-mutation freshness end-to-end. |
| R4 | **Test fragmentation** — every step rewrites a chunk of the dashboard tests | Medium | Treat test churn as expected per-step deliverable; CI green-gate is non-negotiable per step. Plan budgets 20 % per-step time for test updates. |
| R5 | **Coolify proxy buffers the streamed response** | High (blocks Step 3) | §4.1 prerequisite probe before Step 3. If buffering can't be defeated, ship Steps 1+2+4+5 only; Step 3 becomes a v1.6 sub-release. |
| R6 | **`useAuth()` removal breaks deeper client islands** that read `user.timezone` etc. | Medium | Keep `useAuth()` as a thin client-side hook that hydrates from a server-injected `<AuthProvider initial={user}>` at the page boundary. Forms / charts continue to call `useAuth()` unchanged. |
| R7 | **30 sibling client pages** — touching `app/page.tsx` ripples through shared layouts | Low | Migration scope is `/` only. Sibling pages stay client; the `AuthShell` + `Providers` chain stays unchanged. |
| R8 | **React Compiler bundle skew** post-migration vs pre-migration | Low | Bundle-analyzer comparisons in Step 5 must compare same compiler-on config. |

---

## 6. Recommended scope

- **Release:** v1.5 minor (NOT a patch — the architectural shift is observable in production logs + Network tab).
- **Duration:** 2–3 day dedicated marathon.
- **In-flight work:** none. No parallel waves on the dashboard tree; cross-agent commit drift (cf. v1.4.40 W-RSC report and memory note `feedback_cross_agent_commit_drift`) would corrupt step boundaries.
- **PR cadence:** one PR per step (5 PRs total). Each merges to `develop`, deploys to staging, gets a 24-hour soak before the next step ships.
- **Rollback:** every step is reversible by reverting the merge commit. Steps 1+2 are pure refactors with prop-equivalent semantics.

---

## 7. Out-of-scope (explicitly)

1. **Replacing TanStack Query entirely.** It stays for client-island data (`["chart-data", …]`, `["mood-chart-data"]`, mutations, focus refetch). The migration ONLY hoists the page's own slim+thick reads to the server.
2. **Removing the slim/thick split.** Both slices stay — they're the streaming envelope. The server fetches slim eagerly and kicks off thick concurrently for the `<Suspense>` flush.
3. **Migrating sibling `"use client"` pages** (`/insights`, `/measurements`, `/medications`, `/mood`, `/targets`, `/achievements`, etc.). 30 client pages remain client; this plan covers `/` only.
4. **Replacing Recharts with a server-renderable alternative.** Charts stay client (`next/dynamic({ ssr: false })`). Server tiles + client charts coexist behind a single `<Suspense>` per row.
5. **Custom ESLint `no-restricted-syntax` rule for queryKey factory** — deferred from v1.4.40 W-RSC; not blocking this migration.
6. **Long-tail factory migration** (154 bare sites) — deferred from v1.4.40; not blocking.
7. **Service Worker / VersionPoller changes** — VersionPoller stays as-is.

---

## 8. Per-step deliverables checklist (for the future executing agent)

### Step 1 (Day 0.5)
- [ ] `getCurrentUser()` server helper exists and is unit-tested
- [ ] `getServerTranslations(locale)` exists and matches client `t()` output
- [ ] `src/app/page.tsx` is a server component (no `"use client"`)
- [ ] `src/app/dashboard-client.tsx` holds today's body, receives `user` + `locale` props
- [ ] All existing tests pass
- [ ] Network tab unchanged (still ~10 requests on cold mount)
- [ ] Commit: `refactor(dashboard): carve server-component shell around dashboard-client`

### Step 2 (Day 1)
- [ ] `src/lib/analytics/server-fetchers.ts` exports `getSlimAnalytics(userId)` + `getDashboardWidgets(userId)`, both wrapped in `cache()` + `unstable_cache({ revalidate: 60, tags: ["user:<id>:analytics", "user:<id>:widgets"] })`
- [ ] `app/page.tsx` awaits both, passes as props
- [ ] `dashboard-client.tsx` drops the slim `useAnalyticsQuery({ slice: "summaries" })` + widgets `useQuery`
- [ ] `<HydrationBoundary>` hydrates the TanStack cache with the server payload
- [ ] Mutation API routes call `revalidateTag(...)` on the relevant tags
- [ ] Network tab on cold mount: one fewer client request
- [ ] Commit: `feat(dashboard): server-fetch slim analytics + widgets, hydrate client cache`

### Step 3 (Day 1.5)
- [ ] Coolify streaming probe green (§4.1)
- [ ] `bp-in-target-tile-server.tsx` + `glucose-tiles-server.tsx` are async RSCs
- [ ] `app/page.tsx` passes a `thickPromise` (NOT awaited) to those children
- [ ] HTTP response arrives in ≥ 2 flushes (curl `--no-buffer` probe)
- [ ] Commit: `feat(dashboard): stream thick analytics through Suspense`

### Step 4 (Day 2)
- [ ] 10 tile files under `src/components/dashboard/tiles/`
- [ ] `tile-strip.tsx` assembles them from the layout order
- [ ] Inline IIFE in `dashboard-client.tsx` reduced to JSX-only
- [ ] React DevTools shows named components per tile
- [ ] Commit: `refactor(dashboard): one server component per tile`

### Step 5 (Day 2.5)
- [ ] Bundle-analyzer report: route `/` client JS ≤ 60 % of pre-migration size
- [ ] `"use client"` removed from all components that don't use hooks (target: ≥ 15 files)
- [ ] All existing tests pass
- [ ] Commit: `refactor: trim client islands to interactive components only`

### Final
- [ ] CHANGELOG entry under v1.5 — "Dashboard rebuilt on React Server Components for instant initial paint"
- [ ] Marc-voice release-notes blurb (no AI mention, no PII)
- [ ] 24-hour production soak before flipping the v1.5 release tag

---

## 9. Estimated v1.5 effort

| Phase | Days |
| --- | --- |
| Step 0 (prereqs: server helpers, i18n reader, Coolify probe) | 0.5 |
| Steps 1 + 2 (server shell + slim fetch) | 1.0 |
| Step 3 (streaming thick) | 0.5 |
| Step 4 (per-tile servers) | 0.5 |
| Step 5 (client-island trim + bundle verify) | 0.5 |
| **Total** | **3.0 dedicated days** |

Buffer: +0.5 day for test churn / Coolify proxy debug. Real envelope: **2.5–3.5 days**, single autonomous marathon.

---

## 10. References

- Frontend audit C1, C2, H2, H3, H4: `.planning/round-v1439-arch-qa-frontend.md`
- v1.4.40 W-RSC report (Suspense + factory shipped, RSC deferred): `.planning/phase-W-RSC-v1440-report.md`
- Current `app/page.tsx`: 1 495 lines, `"use client"` line 1
- Current `app/layout.tsx`: async RSC, locale + nonce resolved server-side
- 30 sibling client pages under `src/app/` — out of scope
