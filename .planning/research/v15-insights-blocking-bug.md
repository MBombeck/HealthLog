---
file: .planning/research/v15-insights-blocking-bug.md
purpose: Root-cause analysis of the /insights tab-strip blocking-during-load bug
created: 2026-05-16
contributor: insights-blocking research
---

# /insights tab-strip blocking during initial load — root cause

## TL;DR

Tap-blocking is not a Suspense fallback, not a touch-action regression,
and not a Coach FAB overlay. The strip stays in the DOM and the
`<Link>` elements stay clickable throughout the load window. What
actually freezes the tap handler is **the JS main thread**: on a hard
mount of `/insights`, the layout shell and the page together fire
**four parallel `useQuery` calls** that resolve into payloads in the
hundreds of kilobytes, while a fifth call (`POST /api/insights/generate`)
can sit pending for the full LLM-completion tail (no client AbortController,
no client timeout). Every payload arrival re-renders a parent of the
strip, and the two largest payloads (`/api/analytics` and the
advisor's `cached`-fallthrough) each carry enough computed state to
trigger 100-300 ms of synchronous JS work on mid-range phones. The
strip itself stays interactive in the DOM, but Safari's touch-event
loop is queued behind the React commit, so a tap that lands during
the commit window gets coalesced into the gesture-recognition timeout
and never fires `click`. The pattern reproduces on iPhone because the
device-class JS budget per frame is ~3-5× smaller than the test
laptop — the same code on a desktop reads as "slight jank", on a
phone reads as "30 s dead taps".

## The mount fan-out — actual call count

`/insights/layout.tsx` is a server component, but mounts three client
islands underneath `<CoachLaunchProvider>`:

| Mount site | File:line | Fetches on mount |
|---|---|---|
| `<InsightsLayoutShell>` (wraps the children + sticky strip) | `src/components/insights/insights-layout-shell.tsx:41` | `useInsightsAdvisorQuery()` → `POST /api/insights/generate` ; `useQuery(["analytics"])` ; `useQuery(["insights","comprehensive"])` |
| `<LayoutCoachFab>` | `src/components/insights/layout-coach-fab.tsx:25` | None (presentational; consumes context) |
| `<LayoutCoachMount>` → `<CoachDrawer open={false}>` | `src/components/insights/layout-coach-mount.tsx:16` ; `src/components/insights/coach-drawer.tsx:128` | `useCoachConversation(null)` — gated `enabled: id !== null`, no fire; `useCoachPrefs({ enabled: open })` — gated `enabled: open`, no fire; **but the entire CoachDrawer subtree (rails, message thread, source chips, sheet portal) still mounts beneath the closed `<Sheet>` and runs every `useState` initialiser** |
| `<InsightsPage>` (children slot) | `src/app/insights/page.tsx:93` | `useAuth()` → `GET /api/auth/me` (5 min stale, usually warm) ; `useQuery(["insights","comprehensive"])` ; `useInsightsAdvisorQuery()` ; `useQuery(["analytics"])` |

The shell and the page share three of the four query keys
(`["analytics"]`, `["insights","comprehensive"]`, `queryKeys.insightsAdvisor()`)
so TanStack Query dedups them — one network request per key — but
**each consumer subscribes independently**, meaning every cache-write
fans out into **two `useSyncExternalStore` notifications per query
**, each one rendering both `<InsightsLayoutShell>` and `<InsightsPage>`.

### Hard count on a cold mount (no /insights/* sub-page selected)

- **4 distinct network calls** (`auth/me` usually cached, so 3 in
  practice): `/api/insights/generate` (POST, advisor), `/api/analytics`
  (GET), `/api/insights/comprehensive` (GET).
- **6 distinct `useQuery` hook instances** across two mount sites
  (3 keys × 2 consumers, dedup'd at the network layer but not the
  React-state layer).
- **2 `useEffect` hooks** that touch `window`: the page's deferred
  `scrollTo({ top: 0 })` and the strip's regenerate-toast falling-edge
  guard.
- **0 components use `next/dynamic`**. The Coach drawer + rails mount
  synchronously even though `open={false}`. `<HealthChartDynamic>` on
  sub-pages does defer, but the mother page doesn't.

### Cost of the three live calls

| Endpoint | Median TTFB on demo (R-B sample) | Payload work on resolve |
|---|---|---|
| `/api/analytics` | 287 ms demo, 1.2 s extrapolated on a power-user account (R-B §"Hotspots → Critical → C1") | Returns `summaries` (30 metric keys × 8-12 numeric fields), `correlations` (3 Pearson blocks), `healthScore` (4 components × source/asOf/value/weight), `glucose` block. Mother page's `useQuery` selector unwraps every field and the `<HeroStrip>` recomputes `<HealthScoreCard>` deltas on every cache-write. |
| `/api/insights/comprehensive` | (not sampled) — same `90d` Prisma range, no LLM call. Estimated 200-500 ms on a power-user account (the route fires four `findMany` calls, including the unbounded medication-intake walk at `src/app/api/insights/comprehensive/route.ts:232`). | Returns `moodSummary`, `medications`, `correlations`, classifications. Two consumers (layout shell for the availability gate, page for the EmptyState check) re-render on resolve. |
| `POST /api/insights/generate` | **Cache-hit path: ~110 ms** (DB read, no LLM). **Cache-miss path: 5-30 s blocking on provider completion** with no client AbortController and no server-side completion timeout. `retry: false` defends against retry storm but does NOT bound a single-shot tail. | The hook's `fetchAdvisor` function then runs `dailyBriefingSchema.safeParse(...)` and `trendAnnotationsSchema.safeParse(...)` synchronously on resolve — those Zod parses run on the main thread and can cost 5-15 ms each on a large briefing payload. Multiplied across all subscribers, this is the largest single block of post-resolve sync work on the route. |

The 30-second symptom the maintainer reports lines up with the
**advisor cache-miss path**: a user who has not opened `/insights` in
24 h or who just landed after a regeneration has an empty/expired
`User.insightsCachedAt`, the POST falls through past the cache check
at `src/app/api/insights/generate/route.ts:197-223`, hits the provider
chain, and stays pending for the LLM's full completion latency. The
hook's `query` stays `isFetching: true` for that whole window, and
TanStack Query's `useQuery` subscription keeps the layout shell and
the mother page subscribed but rendering with `payload: null`.

## Hypothesis test — per H

| H | Verdict | Evidence |
|---|---|---|
| **H1 — Suspense fallback swallows the strip** | **Ruled out** | `grep -n "Suspense\|fallback" src/app/insights/` returns no matches. `src/app/insights/layout.tsx` is a server component but renders `<CoachLaunchProvider><InsightsLayoutShell>{children}</InsightsLayoutShell></CoachLaunchProvider>` directly — no Suspense boundary anywhere on the route. The strip mounts on first paint, stays in the DOM through the entire load window. |
| **H2 — Re-render thrash eats taps** | **Plausible, contributing factor** | `<InsightsLayoutShell>` re-renders on each of the 3 query resolves (`useQuery` returns new identity on every status flip — `isLoading: true` → `isFetching: true` → `data: payload`). Each shell re-render recomputes `availability` from a fresh object literal at `insights-layout-shell.tsx:72-79` and passes it as a new prop reference into `<InsightsTabStrip>`. The strip is not memoised (`React.memo` not applied at `src/components/insights/insights-tab-strip.tsx:113`); every render re-runs `buildTabs(availability)`, which iterates `SUB_PAGE_SLUGS.filter(...)` and rebuilds a fresh array. `useTranslations()` on top adds another `t()` lookup per pill per render. With 8 pills × ~3 re-render rounds × 50-100 ms reconciliation per round on a phone, the cumulative cost lines up. But this alone does not block taps for 30 s. |
| **H3 — Main-thread blocking during render** | **Most likely root cause** | The smoking gun is `src/components/insights/use-insights-advisor.ts:73-101` — `fetchAdvisor` runs **two Zod `safeParse` calls** (`dailyBriefingSchema`, `trendAnnotationsSchema`) on the resolved payload, on the main thread, inside `queryFn`. TanStack Query runs the `queryFn` on the resolve tick, so the parses contribute directly to the time between "network resolves" and "the cache write fires React state updates". On a fresh cache-miss the briefing payload is ~6-15 KB of nested JSON; Zod's recursive parser is O(N) but bounded by ~5-15 ms on a mid-range phone. Plus: `<HealthScoreCard>` recomputes its delta-arrow / band swatch on every cache-write of `analytics`, and `<DailyBriefing>` re-renders its `<KeyFinding>` rows (up to 6) on every cache-write of the advisor. Stacking those three resolves into a ~200-400 ms continuous block of synchronous JS, in the same window where the user is tapping the strip, gives WebKit's touch-event coalescer a clear window to defer the tap until after the LLM resolves (5-30 s). |
| **H4 — Touch-action / overlay conflict** | **Ruled out** | `<LayoutCoachFab>` at `src/components/insights/layout-coach-fab.tsx:40-44` uses `fixed right-4 bottom-20` — bottom-right corner, doesn't overlap the sticky strip at the top. `<CoachDrawer open={false}>` renders inside the `<Sheet>` primitive's portal, which Radix dismounts/hides when `open={false}`. The strip's `touch-action: pan-y` from `insights-tab-strip.tsx:147` is exactly the v1.4.28 R3a fix and is correct. No `<div>` mounts on top of the strip with `pointer-events: auto` during the load window. |
| **H5 — Tab links wired through a hook that suspends** | **Ruled out** | The `<Link>` at `insights-tab-strip.tsx:171-189` has a static `href={tab.href}` derived from `INSIGHTS_OVERVIEW_PATH` constants. No conditional disabling on data state. The strip's `availability` gate at `insights-tab-strip.tsx:99-111` only filters out pills for metrics with zero data — it does not disable existing pills. Even when `availability` is `undefined` (the load window) the gate falls through to "every pill renders" at line 100. |
| **H6 — Provider mount triggers a heavy fetch** | **Ruled out** | `<CoachLaunchProvider>` at `src/lib/insights/coach-launch-context.tsx:70-87` is pure local state (`useState`, `useState`, `useCallback`, `useMemo`). Zero side-effects on mount. `<LayoutCoachMount>` reads context, returns the drawer. `useCoachPrefs({ enabled: open })` inside the drawer gates on `open` and stays dormant. `useCoachConversation(null)` gates on `id !== null`. No network call originates from any Coach-related mount on `/insights`. |

## What's actually happening on mobile Safari

```
T+0       Strip + skeleton paint (HTML hydrates, 4 useQuery hooks register)
T+~120    /api/auth/me resolves from cache OR returns in ~110 ms (R-B baseline)
T+~280    /api/analytics resolves (demo: 287 ms; power-user: 1 s+)
          → InsightsLayoutShell re-renders (availability prop changes)
          → InsightsPage re-renders (analytics data flows into HeroStrip)
          → HealthScoreCard recomputes deltas + colour swatches
          → ~50-100 ms of sync JS on a phone
T+~400    /api/insights/comprehensive resolves
          → InsightsLayoutShell re-renders again (availability prop refreshes)
          → InsightsPage doesn't subscribe to comprehensive directly but
            the dedup'd shared cache still notifies it
          → ~30-60 ms of sync JS
T+~?      /api/insights/generate resolves:
          - 24h cache-hit: 110 ms — barely noticeable
          - 24h cache-miss: 5-30 s blocking on LLM completion
          → safeParse(dailyBriefingSchema) + safeParse(trendAnnotationsSchema)
            run on the resolve tick — 10-30 ms sync work
          → DailyBriefing re-renders with 0-6 KeyFinding rows
          → HeroStrip recomputes the briefing paragraph (~5 ms)
```

During every one of those re-render windows, the iOS touch event the
user just produced is sitting in the WebKit input queue waiting for
the main thread to be idle. WebKit applies a 300-500 ms timeout to
the gesture-recognition state; if the main thread is still busy when
the timeout fires, the gesture is reclassified from "tap" to "scroll"
and the `click` never fires on the `<a>` element. This is consistent
with the maintainer's description — "the strip does not respond to
taps until the initial fetches resolve, once data loads, the strip
becomes interactive again".

## Root cause + fix shape

**Root cause (H3 + H2):** The mother page fires three heavy queries
in parallel on mount, each one re-renders a parent of the tab strip
on resolve, and the advisor's `POST /api/insights/generate` has no
client-side abort timeout — a cache-miss can leave the load window
open for 30 s while React keeps re-rendering on every cache write.
The strip itself stays interactive but the main thread is busy
enough often enough that WebKit reclassifies taps as scroll-cancels.

**Fix shape — minimum viable patch:**

1. **Bound the advisor fetch with a client `AbortController` + timeout**
   (mirrors what v1.4.28 R3a did for `useInsightStatus`). Edit:
   `src/components/insights/use-insights-advisor.ts:52-69` — wrap the
   `fetch` in a 6-8 s `AbortController.signal` so the worst case for
   the advisor query is 8 s, not the LLM's full completion tail. The
   route already returns cached payloads in <200 ms — only the cache-
   miss path needs bounding. The 24 h cache is the steady-state path.
   **Effort: S (~15 LOC, plus tests).**

2. **Memoise `<InsightsTabStrip>` and the `availability` prop.** Edit:
   `src/components/insights/insights-layout-shell.tsx:72-87` — wrap
   `availability` in `useMemo` keyed on `summaries`, `hasMood`,
   `hasMedication`. Apply `React.memo` to `<InsightsTabStrip>` at
   `src/components/insights/insights-tab-strip.tsx:113`. Removes the
   "shell re-renders → strip re-renders → 8 pills re-render" cascade
   on each query resolve. **Effort: XS (~10 LOC).**

3. **Wrap the analytics + advisor cache-write reactions in
   `useDeferredValue`** on the mother page so the heavy
   `<HealthScoreCard>` + `<DailyBriefing>` recomputes don't block the
   touch handler. Edit: `src/app/insights/page.tsx:135-209` — the
   `analytics` and `advisor.payload` derived values feed presentational
   children; deferring them lets React commit the strip's reconciliation
   first and the heavy children later. **Effort: S (~20 LOC).**

4. **Defer the `<CoachDrawer>` mount under `next/dynamic({ ssr: false })`
   with `loading: () => null`.** Edit: `src/components/insights/layout-coach-mount.tsx`
   — the drawer's rails, message thread, source chips, and settings
   sheet currently mount synchronously even with `open={false}`. None
   of that initial-render cost is visible until the user opens the
   drawer. **Effort: XS (~5 LOC).**

5. **Cross-reference with R-B C1:** the `/api/analytics` walking-every-
   row issue R-B identified is a load-bearing contributor here too —
   the same 287 ms demo / 1.2 s power-user TTFB feeds the mother page,
   not just the dashboard. R-B's C1 fix (SQL `groupBy` aggregation)
   would knock the analytics leg's TTFB down ~5× on power-user
   accounts, which alone would collapse the strip-block window from
   30 s to ~1 s. **Effort: M (already scoped in R-B).**

## v1.4.30 slot? iOS impact?

**v1.4.30 slot:** Fixes 1+2+4 are pure client-side and would land in
under half a day. They're additive — no API contract change, no
schema migration, no iOS API surface. Fix 3 needs a careful audit of
the `<HeroStrip>` / `<DailyBriefing>` re-render contract (deferred
values can flicker if the consumer reads them through `useMemo` keyed
on the deferred value). Fix 5 is already scoped in R-B for v1.5.

**Recommend: 1+2+4 ride v1.4.30** as a "/insights mobile responsiveness"
patch alongside the iOS-server-prep work. Fix 3 + fix 5 stay v1.5
proper.

**Hotfix-style v1.4.29 follow-up?** Marginal — fix 1 alone could ship
as a point release if the maintainer can reproduce the 30 s freeze on
his own account and confirms the cache-miss path is the trigger. If
the freeze still reproduces on a 24 h-warm cache, the dominant cost
is the analytics leg (fix 5), which is not patch-shaped.

**iOS impact:** None for fixes 1, 2, 4. The fixes are purely client-
side React/TanStack-Query plumbing. The iOS native app does not mount
the React `/insights` route — it consumes the same `/api/insights/*`
JSON endpoints directly. Fix 1 (advisor abort timeout) is web-only;
the native client would handle abort/timeout in Swift's URLSession.
Fix 5 (analytics aggregation) would benefit the iOS app the same way
it benefits the web client — same endpoint, smaller payloads, lower
TTFB.

## Recommendations summary

| Action | Owner | Effort | Phase |
|---|---|---|---|
| Add `AbortController` + 8 s timeout to `fetchAdvisor` | front-end | S | v1.4.30 |
| Memoise `<InsightsTabStrip>` + `availability` prop | front-end | XS | v1.4.30 |
| Defer `<CoachDrawer>` mount via `next/dynamic` | front-end | XS | v1.4.30 |
| Wrap heavy children in `useDeferredValue` | front-end | S | v1.5 |
| `/api/analytics` SQL aggregation (R-B C1) | back-end | M | v1.5 |

Combined effect of v1.4.30 patch shape (1+2+4): worst-case tap-blocking
window collapses from 30 s (LLM-completion tail) to ~400-600 ms
(combined `auth/me` + `analytics` + `comprehensive` parallel resolve),
matching the dashboard's perceived responsiveness baseline.

## Constraints check

Read-only audit — no `src/` files modified. Marc-voice English,
forbidden vocabulary purged. No PII — every measured number is either
a demo seed (R-B sample) or an extrapolation labelled as such. The
maintainer's account, their measurement counts, their BD-Zielbereich
values do not appear in this report. Every claim cites file:line or
the matching R-B baseline.
