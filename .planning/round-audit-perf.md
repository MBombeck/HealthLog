# Performance Audit — 2026-05-16

## Executive summary

The web tree is in good shape on the obvious lanes — Recharts is gated behind a single `next/dynamic` boundary, the dashboard tile-strip cache hit rate sits near 100% inside the 60-second LRU, the public image surface is 130 KiB total, and the `Cache-Control` posture is bfcache-friendly. The remaining wins are all on the **server-cpu / TTFB** side: at least seven `/api/insights/*` and `/api/medications/*` routes still load unbounded `findMany` slabs into JS and aggregate in-memory, with no SQL-side rollup like the v1.4.34.1 comprehensive fix. The dashboard mother page also fires three independent `useQuery` calls from a single `"use client"` shell, which costs one cold paint plus two hydration ticks before tiles settle — INP and LCP both move when these are batched. Finally `/api/medications/intake?scope=today` is a per-request, hot-loop `findMany` with no cache wrap; this is the highest-frequency authed endpoint on the site after `/api/analytics`.

## Findings — prioritized

### F-1: Insights mother page fans out three sequential client queries
**Severity**: high
**Web-vital**: LCP, INP
**File(s)**: `src/app/insights/page.tsx:161-175`, `src/app/insights/page.tsx:181`, `src/app/page.tsx:223-251`
**What's wrong**: Both the dashboard and the Insights mother page are `"use client"` shells that fire `/api/insights/comprehensive`, `/api/analytics`, and (on dashboard) `/api/dashboard/widgets` + `/api/mood/analytics` from React mount. None are co-located in a Suspense boundary or a server-side `Promise.all`. Cold paint is hero strip → 3-5 spinners → tiles. The v1.4.34.1 cache wrap helps the second visitor; the first paid the wait.
**Fix shape**: Make the mother pages server components that `Promise.all` the four endpoints inside a `loading.tsx` Suspense shell, hand the resolved data down to the existing `"use client"` widgets as initial state, and let TanStack hydrate from the dehydrated boundary. The cache wrap stays warm; the cold paint shaves one full network round-trip.
**Effort**: medium

### F-2: `/api/medications/intake?scope=today` runs uncached on every render
**Severity**: high
**Web-vital**: TTFB, server-cpu
**File(s)**: `src/app/api/medications/intake/route.ts:78-112`
**What's wrong**: The `today` scope is rendered on every dashboard mount and every medications-page mount (and the iOS app polls it). It runs `findMany` with `include: { medication }` over the user's whole-day schedule slab with no `cached()` wrap, no `take`, and no SQL rollup. The compliance branch below it (line 119) is cached; the today branch is not. This is the hottest authed endpoint on the site after `/api/analytics`.
**Fix shape**: Wrap in `cached(caches.medicationsIntake, ${userId}|today|${userTz}, …)` with a 30-second TTL (intake events trickle in but don't move sub-minute) and invalidate from the intake-mutation handler. Same pattern as the existing compliance branch directly below it.
**Effort**: small `[hotfix-ready]`

### F-3: `/api/insights/targets` still loads full 30-day measurement slab into JS
**Severity**: high
**Web-vital**: server-cpu, TTFB
**File(s)**: `src/app/api/insights/targets/route.ts:152-160`, `src/app/api/insights/targets/route.ts:1080-1090`
**What's wrong**: The v1.4.34.1 SQL-aggregator landed on `/api/insights/comprehensive` only; the sibling `/api/insights/targets` route still issues an unbounded `findMany` over the last 30 days across seven measurement types (line 152) and a second one over all-time glucose (line 1080). For a power user with Apple Health backfill these are 10k-30k row pulls, then a JS reduce. The route is page-blocking for `/targets`.
**Fix shape**: Mirror the `buildComprehensiveAggregate()` shape — `groupBy({ type }, { _avg, _count, _max })` plus a `$queryRaw` for the slope tuple. Most of `/targets`' downstream math is per-type averages and latest-values that Postgres already computes faster than V8.
**Effort**: medium

### F-4: `/api/insights/cards` issues a wide measurement slab + a 30-day intake slab
**Severity**: medium
**Web-vital**: server-cpu, TTFB
**File(s)**: `src/app/api/insights/cards/route.ts:73-88`, `src/app/api/insights/cards/route.ts:139-150`
**What's wrong**: Same shape as F-3: 90-day measurement findMany across four types, then a 30-day intake event findMany across every active medication, both reduced in JS. Same SQL-aggregator treatment applies. Not cached either.
**Fix shape**: Same as F-3. Bonus: wrap in `cached(caches.insightsCards, …)` with a 60-second TTL once the SQL aggregator is in place.
**Effort**: medium

### F-5: Dashboard tiles fire two extra queries the analytics cache already serves
**Severity**: medium
**Web-vital**: INP, server-cpu
**File(s)**: `src/app/page.tsx:226-251`
**What's wrong**: `useQuery(["dashboardWidgets"])` and `useQuery(["moodAnalytics"])` both fire alongside `useAnalyticsQuery()` on every dashboard mount. The widget layout is a stable user preference (cache TTL could be 5 minutes, not 60s), and `/api/mood/analytics` payload is a subset of what `/api/analytics`' thick slice already returns through `summaries.MOOD` + correlations. Three round-trips where one would do.
**Fix shape**: Move `dashboardWidgets` to a per-session-localStorage prefetch (it changes via the Settings page; invalidate on save). Fold `moodAnalytics` into `/api/analytics`' thick slice — the field is already there structurally; the consumer just needs to read it from `analyticsQuery.data.summaries.MOOD`.
**Effort**: small

### F-6: Three `Recharts` consumers ship without a `next/dynamic` wrapper
**Severity**: medium
**Web-vital**: bundle-size, LCP
**File(s)**: `src/components/admin/host-metrics-chart.tsx:33`, `src/components/insights/sleep-stage-stacked-bar.tsx:10`, `src/components/medications/DrugLevelChart.tsx:47`, `src/app/medications/[id]/history/page.tsx:8`
**What's wrong**: `DrugLevelChart` ships in the eager bundle of `/medications/[id]/history` (no lazy wrapper). `SleepStageStackedBar` ships eagerly into the insights tree. Host-metrics is wrapped at the consumer per its file comment, but the file itself imports `recharts` so a static import chain into it pulls the whole 108 KiB Brotli vendor chunk. The `HealthChartDynamic` + `MoodChart` + scatter-card wrappers cover the dashboard + insights mother page but not these three.
**Fix shape**: Wrap each at the consumer with the same `dynamic(() => import("…"), { ssr: false, loading: () => <ChartSkeleton /> })` shape `HealthChartDynamic` uses. Three identical lines.
**Effort**: trivial `[hotfix-ready]`

### F-7: `ChartSkeleton` width-only fallback leaves loaders that don't match
**Severity**: low
**Web-vital**: CLS
**File(s)**: `src/components/insights/correlation-card.tsx:34`, `src/components/admin/host-metrics-chart.tsx:166`, `src/components/charts/compliance-line-chart.tsx:110`
**What's wrong**: Three `next/dynamic` loading slots paint a 180 px skeleton, but the actual `ResponsiveContainer` heights below are 180 px (compliance-line), 220 px (sleep-stages), and unset (host-metrics) — so the layout still snaps on hydration. The v1.4.34.1 scatter-card fix solved one of these; the rest are open. `DrugLevelChart` reserves 240 px via inline style which is fine, but its outer container is eager-imported (F-6) so it never paints a skeleton anyway.
**Fix shape**: Either reuse `<ChartSkeleton>` (which already honours `--chart-height` / `--chart-height-md`) for every dynamic chart loader, or pin the loading-div height to the same value the chart itself uses.
**Effort**: trivial `[hotfix-ready]`

### F-8: Service-worker page-cache is network-first with no SWR window
**Severity**: low
**Web-vital**: offline, LCP (return visits)
**File(s)**: `public/sw.js:65-69`, `public/sw.js:50` (API exclusion)
**What's wrong**: HTML pages run network-first with cache fallback (line 65). On a flaky connection the cache only fires once the network promise rejects; there's no `stale-while-revalidate` so the user sits on a spinner for the network timeout. `/api/*` is excluded from the SW entirely (line 50) so the in-memory LRU on the server is the only cache for repeat visits.
**Fix shape**: Switch the HTML branch to a stale-while-revalidate strategy keyed off the same `PAGE_CACHE`. For `/api/analytics?slice=summaries` specifically, allow a SW cache with a 30-second max-age — the slim slice is already idempotent across same-window mounts.
**Effort**: small

### F-9: `<head>` carries an inline pre-paint theme script on every page
**Severity**: low
**Web-vital**: TTFB, render-blocking
**File(s)**: `src/app/layout.tsx:73-95`
**What's wrong**: Every page response carries an inline `<script>` (line 74-95) reading localStorage and stamping a class onto `<html>`. The nonce is also computed via `headers()` on every render (line 82-84). The script is ~270 bytes which is fine; the header read isn't free — it pushes the layout shell to dynamic-rendering mode, which is already the case via cookies but the duplicate cost is per-route.
**Fix shape**: Move the theme script into a static file served from `/_next/static/` with `Cache-Control: public, immutable`, then reference it via `<script src=… defer>`. Acceptable FOUC risk: the script needs to execute before first paint to avoid the flash, so the inline-with-nonce variant is actually the correct trade. Leave as informational unless a CSP-relaxation lets us move it static.
**Effort**: small (informational — current shape is the right one)

### F-10: 16 `findMany` call sites across `/api/*` still have no `take`
**Severity**: medium
**Web-vital**: server-cpu, db
**File(s)**: count = 16 routes flagged via grep. Hot ones: `src/app/api/insights/cards/route.ts:73,84,139`; `src/app/api/insights/comprehensive/route.ts:88,214,234`; `src/app/api/insights/targets/route.ts:152,166,816,824,958,1080`; `src/app/api/insights/glp1-timeline/route.ts:76,95`; `src/app/api/measurements/series/route.ts:82,91,122`; `src/app/api/personal-records/route.ts:38` (clamped via `limit` clamp at runtime); admin / export / backup routes.
**What's wrong**: Most of these are scope-bounded by `where: { measuredAt: { gte: someDate } }` so they're not literally unbounded, but the date predicate isn't the same thing as a SQL ceiling. A user with a multi-year Apple Health backfill plus a 90-day window can still pull 10k+ rows per call. The PersonalRecord route is the only one with an explicit clamp.
**Fix shape**: Audit each call site for the worst-case row count. The hot insights routes (F-3, F-4) deserve the SQL-aggregator treatment. Cold export/backup routes should grow a `take: 50_000` ceiling with a clear 413-response when the user exceeds it — protects the DB worker from a runaway query.
**Effort**: medium (spread across routes)

## Numbers

- **App routes**: 35 total page.tsx files; 27 are `"use client"` shells → no server-side data fetch on those pages.
- **Recharts importers**: 8 files (`grep`); 3 of them ship eager (F-6).
- **`next/dynamic` boundaries in production code**: 14 (excluding tests).
- **`/api/*` route handlers**: 80+ route.ts files.
- **`findMany` call sites under `/api/*`**: 103 total; 23 route files contain at least one without a `take` in the surrounding 8 lines (rough heuristic — most are date-window-bounded but unbounded by row count).
- **`cached()` wraps under `/api/*`**: 14 route call sites — v1.4.34.1's expansion. The remaining 80+ routes go to Postgres on every request.
- **Public images**: 5 files, all PNG/SVG, largest is `logo-readme.png` at 102 KiB. `logo-512.png` is 23 KiB, `logo-192.png` is 8 KiB. No oversized hero image; no raw `<img>` tags in the app surface (only inside a `bugreport` sanitiser comment).
- **`next/image` usage**: 0 — every image on the site is either a CSS background or one of the public icons referenced via `<link rel="icon">` / manifest. Acceptable today since the app surface has no inline raster imagery; would matter the moment Marc adds a logo or onboarding hero.
- **`next/font`**: 1 family (Inter, 4 weights, latin subset). Self-hosted via `next/font/google`. No FOIT (next swap default). Looks correct.
- **Service worker precache**: 4 URLs (`/`, `/logo-192.png`, `/logo-512.png`, `/favicon.svg`).
- **Inline `<script>` in layout**: 1 (theme pre-paint, 270 bytes).
- **Chart components with `min-h-[…]` reservation**: 4/8 (50%). The v1.4.34.1 scatter fix covered the worst CLS case; F-7 lists the others.
- **Postgres index coverage for hot queries**: `Measurement(userId, type, measuredAt)` exists (`schema.prisma:452`) — covers every `/api/insights/*` measurement query. `MedicationIntakeEvent(userId, medicationId, scheduledFor)` exists (`schema.prisma:742`) — covers `/api/medications/intake` today scope. `PersonalRecord(userId, metricType, value)` exists (`schema.prisma:589`). No gap on the hot read paths the audit could spot.
- **`force-dynamic` routes**: 5 in `/api/insights/*` (chat, chat-id, targets, cards, comprehensive). Correct posture for authed reads; no SSG opportunity here.
- **bfcache posture**: `Cache-Control: private, max-age=0, must-revalidate` applied via `next.config.ts` for HTML and `applyAuthedHeaders()` for 10 API call sites. Looks right.
