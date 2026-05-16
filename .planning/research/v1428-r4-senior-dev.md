---
file: .planning/research/v1428-r4-senior-dev.md
purpose: R4 senior-dev review — architecture, schema, edge cases, race conditions across the v1.4.28 diff
created: 2026-05-16
contributor: R4 senior-dev
---

# v1.4.28 R4 — senior-dev review

Scope: 30 commits since `v1.4.27` on `develop` (`538b44f7` → `5570971f`), 126 files, +4355 / −8227. Architectural and correctness eye. Read-only.

Plan and r1-performance documents referenced in the brief (`.planning/v1428-fix-plan.md`, `.planning/research/v1428-r1-performance.md`) are not present in the tree at review time — calibration runs against the marathon-kickoff (`v1428-marathon-kickoff.md`) and the feedback intake (`v1428-feedback-2026-05-15.md`) instead. Findings reference the actual diffs.

---

## Severity-grouped findings

### Critical

| ID | Severity | File:line | Architectural concern | Recommendation |
|---|---|---|---|---|
| **SD-C1** | Critical | (no commit since v1.4.27) | **FB-B1 not addressed.** Maintainer feedback flagged "Sport edit + save → error" as Critical. The only save-path fix in the diff is `538b44f7` on `/api/measurements/[id]` (P2002 → 409). There is no PUT / PATCH `/api/workouts/[id]` route in the tree, and no commit since v1.4.27 touched the workout edit path. If FB-B1 actually meant the workout-detail edit Sheet, the bug is unrepaired. If it meant the measurement edit Sheet, the fix is real but the release note should call that out so the maintainer knows what got addressed. | Reproduce FB-B1 against `healthlog.bombeck.io` before tag. If the error is measurement-edit, document the mapping (FB-B1 == 409 fix) in the closure report. If it is workout-edit, ship the analogous fix on whichever route the workout-detail surface POSTs to (likely an as-yet unaudited handler). |
| **SD-C2** | Critical | `src/app/api/internal/web-vitals/route.ts:1` (`ebf83b1e`) | Beacon route is publicly reachable, unauthenticated, **no rate limit, no CORS gate**. Comment claims "internal-only by name; CSP + same-origin keeps cross-site out" — false; any client can POST. Every accepted payload calls `annotate(...)` and lands in the wide-event pipeline. A drive-by flood writes unbounded entries into Sentry / log storage and costs money. | Gate with `apiHandler` auth (Web Vitals only fire from authenticated pages) or wire the existing rate-limiter (~30 req/min/IP) plus an origin allow-list. Pure beacon does not mean ungoverned ingestion. |

### High

| ID | Severity | File:line | Architectural concern | Recommendation |
|---|---|---|---|---|
| **SD-H1** | High | `src/components/charts/health-chart.tsx:519-538` (`b00be286`) | **Behaviour change on the "All time" range.** Pre-fix the chart walked the full measurement history; `computeWindowTrend` ran split-half delta across the user's true lifetime. Post-fix `rangePoints === 0` silently defaults to a 365-day window. A user with three years of weight sees "All time" trend = trailing 12 months. Commit body never acknowledges this. | (1) When `rangePoints === 0` pass `from` = the user's earliest measurement via a tiny `findFirst`; weekly aggregation collapses the payload. (2) Or relabel `charts.pointsAllLabel` to "Last 12 months" so the UI matches the data. Either decision is fine; the silent narrowing is not. |
| **SD-H2** | High | `src/lib/notifications/dispatch-localised.ts:84-131` (`b0ef80dc`) | **LRU TTL has no proactive sweep — expiry is passive.** The cache only checks `expiresAt > Date.now()` on read. A worker that dispatches to user `A` once then to thousands of distinct users never re-reads `A`; the stale entry sits in the Map until FIFO eviction at the 1000-entry cap. Memory bound is fine. The real risk: comment claims "next read after 30 s re-validates" but reads, not wall-clock, drive validation. Doc misleads future maintainers. | Optional: a 60-s `setInterval` sweep is 10 LOC. Or fix the comment to "passive expiry on read". |
| **SD-H3** | High | `src/hooks/use-insight-status.ts:85` (commit `0d591ac9`) | `retry: 0` on every `useInsightStatus` query is paired with the deterministic-fallback shape from the status routes — that pairing is sound. But **any genuine 5xx from the route itself** (Prisma down, route throws before the timeout wraps the provider) now surfaces as a hard error with zero retries. Previously React-Query's default 3 retries would absorb a transient Prisma blip. The status card user experience for real outages got worse, not better. | Set `retry: (failureCount, error) => failureCount < 2 && /* error is not the deterministic-fallback envelope */` — or, simpler, keep `retry: 0` but make the route catch every error path and always return the deterministic envelope (so the 200 status code carries the failure signal in the body). The current shape does both: 200 + envelope on provider timeout, 5xx + throw on Prisma error. Pick one. |
| **SD-H4** | High | `235e52cb` / `0e7c97c5` | **Two mislabelled commits.** `235e52cb` says "single HealthChartDynamic re-export" but the diff carves out `<MobileRailTray>`. `0e7c97c5` says "align briefing empty-state CTA variant" but the diff is the trends-row equal-height contract (the CTA flip is one line). The real chart-re-export work is in `8f3bfc37`. Functionally correct; auditability is the cost — `git log --grep` misses the change locations. | Rewrite the two commit messages before tag (interactive rebase on develop). |
| **SD-H5** | High | `src/components/insights/metric-empty-state.tsx:60-72` | The doc-comment promises "The Coach launch always renders (BK-MED-4)". After `4c6d8779` consolidated the FAB into `<LayoutCoachFab>`, `<CoachLaunchButton>` renders **nothing on phone-class viewports** (the inline pill is `hidden lg:inline-flex`). The empty state on phone therefore has no inline Coach affordance — only the global FAB at the layout root. Functionally the FAB is always visible, but the empty state's own copy claims a per-card affordance. | Either drop the `<CoachLaunchButton>` mount from `<MetricEmptyState>` (acknowledge the FAB is the answer on phone, the inline pill on desktop) — or change `<CoachLaunchButton>` to render the inline pill at every breakpoint when it is mounted inside an empty state (use a `prominent` prop). Current state is "renders nothing on phone, the comment lies about it." |

### Medium

| ID | Severity | File:line | Architectural concern | Recommendation |
|---|---|---|---|---|
| **SD-M1** | Medium | `src/components/insights/health-score-delta-explainer.tsx:84-95` | The mobile branch wraps the inner `<button>` trigger in a non-focusable `<span onClick onKeyDown>`. The keydown is dead (the span has no `tabIndex` so it never holds focus); the click works only because the inner button's default click bubbles to the span. Net effect: a redundant outer wrapper that mistakes itself for keyboard-handler scaffolding. | Replace the span wrapper with a direct `<button onClick={() => setOpen(true)}>` and drop the cloned trigger pattern. The popover branch's `<PopoverTrigger asChild>` already does the right thing; do the equivalent on the sheet branch by lifting `setOpen` into the inner button. |
| **SD-M2** | Medium | `src/components/charts/health-chart-dynamic.tsx:1-29` (commit `8f3bfc37`) | `<HealthChartDynamic>` re-export collapses six call sites onto one boundary — good. But the dynamic-import inference loses the explicit props contract: callers now pass `<HealthChartDynamic types={...} title={...} ... />` whose typing relies on `dynamic()` round-tripping the inner module's component type. If a future refactor renames a `<HealthChart>` prop, six call sites get a type error from the inferred type — fine — but a wrong-type assignment at the call site shows up as the dynamic loader's generic prop typing first, which can be confusing. | Add an explicit `ComponentProps<typeof HealthChart>` re-export alongside the dynamic — `export type HealthChartDynamicProps = ComponentProps<typeof HealthChart>` — so callers can spread typed props through. Cheap forward-compat. |
| **SD-M3** | Medium | `src/lib/insights/with-timeout.ts:26-64` | The helper resolves with `{ timedOut: true, value: fallback }` on **both** timeout and upstream rejection. That is intentional (commented "the caller does not have to learn another failure mode") but means the `timedOut` field overloads two distinct failure modes. The status routes treat them identically; future callers that need to distinguish "took too long" vs "actively errored" cannot. | Optional. Either keep the current shape (and document the overload explicitly) or widen the envelope to `{ outcome: "ok" \| "timeout" \| "rejected"; value: T }`. Tests pin the current shape so either way the change is contained. |
| **SD-M4** | Medium | `src/components/insights/sub-page-shell.tsx:64-82` (commit `ac80c099`) | The `rAF`-deferred scroll-reset effect depends on `[focusOnMount]` and cleans up via `cancelAnimationFrame`. Mount-time race: on a fast back-navigation from sub-page → `/insights`, the sub-page's `<SubPageShell>` unmounts (cancel fires), then `/insights` page mounts and schedules its own rAF. Cleanup-vs-schedule is single-threaded so this works. The subtler issue: `focusOnMount` is a prop, so any caller that re-renders the shell with `focusOnMount={true}` triggers a re-schedule even on data fetches mid-page-life. Today no caller flips this mid-session, but the effect would fire a `scrollTo({top: 0})` on every change — visible jump. | Decouple: scroll-reset effect on `[]`, focus effect on `[focusOnMount]`. Two effects, two intents. Current single effect mixes them. |
| **SD-M5** | Medium | `src/app/api/measurements/route.ts:56-93` (commit `b00be286`) | Server-side aggregation only triggers when **both** `from` AND `to` are present AND the window crosses the threshold ladder. An iOS or third-party client that passes only `from` (or only `to`) goes through the legacy raw path with the new `limit=5000` cap. A scripted client that passes `from` = "1970-01-01" and `to` = "2099-01-01" gets `aggregate=weekly` (good) but a client that passes `from` = "1970-01-01" with no `to` gets raw + 5000-row cap → silent truncation of decades of history. | Default `to` to `now` server-side when missing (one-liner). The legacy contract truncated to 500 rows; the new contract should at least truncate to "the bounded window the client asked for". Document the additivity claim — the iOS contract notes "the iOS client omits all three params" which is fine — but the partial-param case is undefined behaviour today. |
| **SD-M6** | Medium | `src/lib/insights/coach-launch-context.tsx:35-46` (commit `66e13845`) | Narrowing `CoachLaunchScope.metric` from `string` to `CoachScopeSource` is the right call. **But the field is unused.** Every `askCoach()` call site in the diff passes only `prefill`. The drawer never consumes `scope.metric` from the launch context (sources rail uses its own scope state). The narrowed type is dead. | Either wire a real consumer (the drawer reads `coachScope.metric` and pre-narrows the sources rail) or remove the field entirely. Currently it is "documented intent" that the type system enforces — fine, but dead code accrues if v1.4.29 doesn't follow through. Mark it `@deprecated` if unused at tag time. |
| **SD-M7** | Medium | `src/components/insights/__tests__/trends-row.test.tsx:81-90` (commit `0e7c97c5`) | The `next/dynamic` stub in the test renders a single `<div data-slot="trends-row-chart-stub">` for both `<HealthChart>` and `<MoodChart>`. The new assertion `expect(slots.length).toBe(3)` counts `data-slot="trends-row-chart-slot"` wrappers — but the inner chart stub paints uniformly across BP/weight/mood, so a regression that swapped mood's wrapper out wouldn't be caught (the mood `<MoodChart>` has its own dynamic import; the stub catches both via the `vi.mock("next/dynamic")` global). The unit-test masks the behaviour change of the mood chart inheriting the same wrapper. | Acknowledge this as a snapshot-level guarantee, not a behavioural one. Add a Playwright spec that asserts the chart-band top edge is within 4 px across the three tiles in the live row. Pin the trends-row visual contract end-to-end, not just by class name. |

### Low

| ID | Severity | File:line | Architectural concern | Recommendation |
|---|---|---|---|---|
| **SD-L1** | Low | `src/components/charts/health-chart.tsx:549-558` | New `staleTime: 60_000` + `gcTime: 5min` on the chart query is fine. Comparison-overlay re-keys via `effectiveCompareBaseline` — up to 48 cache entries per Insights surface across charts × ranges × overlays. Bounded but worth a comment. | No action — `gcTime` will prune. |
| **SD-L2** | Low | `src/lib/measurements/range-aggregation.ts:115-127` | `bucketStartFor(d, "weekly")` mutates the constructed `monday` Date via `setUTCDate`. The historical DST off-by-one pattern. | Cosmetic. Replace with `new Date(monday.getTime() - (day - 1) * 86_400_000)`. |
| **SD-L3** | Low | `src/components/insights/__tests__/trends-row.test.tsx:73-79` | `expect(html).toMatch(/\bauto-rows-fr\b/)` matches any occurrence of the class anywhere in SSR output, even in text content. Fragile. | Anchor on the container's class attribute. |

---

## Per-new-primitive assessment

| Primitive | File | Verdict | Notes |
|---|---|---|---|
| `<MetricEmptyState>` | `src/components/insights/metric-empty-state.tsx` | Solid carve-out | One-line ergonomic wrapper around `<EmptyState>` + `<CoachLaunchButton>`. Six sub-pages adopt it cleanly. Doc-comment claims a guarantee (Coach always renders) the underlying button does not honour on phone (see SD-H5). Otherwise correct. |
| `<HealthChartDynamic>` | `src/components/charts/health-chart-dynamic.tsx` | Solid carve-out | Six call-sites collapse onto one re-export with the right `ssr: false` + `<ChartSkeleton />` loading state. Re-export inferred props (see SD-M2) — minor. |
| `<MobileRailTray>` | `src/components/insights/coach-panel/mobile-rail-tray.tsx` | Solid carve-out | Pure presentational shell, takes pre-rendered rail nodes, owns no state. Coach-drawer net LOC drops from ~80 inline-Sheet repetitions to one component call. Commit mislabelled (SD-H4). |
| `useInsightsAnalytics` | `src/hooks/use-insights-analytics.ts` | Solid carve-out | Five sub-pages drop 16 LOC each onto a 35-LOC shared hook with `queryKey: queryKeys.analytics()` (consistent with the dashboard cache) and an `isEmpty` derived flag that doesn't flash before data lands. Mood + medication kept their bespoke fetch — correct call, doc notes the reason. |
| `<HealthScoreDeltaExplainer>` | `src/components/insights/health-score-delta-explainer.tsx` | Functional, two polish gaps | Right architectural choice: popover on md+, sheet on phone via existing `<ResponsiveSheet>`. Six locales native translations. Mobile keyboard accessibility path is non-idiomatic (SD-M1). |
| `withTimeout` + `STATUS_PROVIDER_TIMEOUT_MS` | `src/lib/insights/with-timeout.ts` | Right shape, one overload | 64-LOC promise race with typed envelope. Wired into seven status routes. Conflates `timedOut` for "took >20s" and "rejected before timeout" (SD-M3). |
| `aggregateRows` / `pickAggregateGrain` / `rangeLengthDays` | `src/lib/measurements/range-aggregation.ts` | Right shape, weekly-bucket mutation | Server-side range aggregation behind threshold ladders. Daily threshold 90 d, weekly 365 d. Linear in-memory aggregation acceptable given the bounded `take`. Weekly-bucket mutation pattern (SD-L2) is cosmetic. |
| `<LayoutCoachFab>` | `src/components/insights/layout-coach-fab.tsx` | Solid carve-out | Fixes a real a11y-tree duplicate (multiple FAB nodes on phone, each from a sub-page's `<CoachLaunchButton>`). Mounted once at the Insights layout root. The trade-off is that `<CoachLaunchButton>` now renders nothing on phone (SD-H5). |
| `<MedicationCardHeader>` / `<MedicationDetailSection>` | commits `6f6992c6` / `5109e930` | Out-of-scope here | Visual carve-outs; refer to UI-conformity reviewer. |

---

## Schema-migration audit

`git diff v1.4.27..HEAD -- prisma/` returns **empty**. Zero Prisma schema or migration changes in this release. Consistent with the "polish cycle" framing in the kickoff. No iOS-contract risk from this surface.

The new `aggregate` query param on `GET /api/measurements` is additive (Zod schema accepts a missing field; the route's aggregation branch only engages when both `from` and `to` are present). The new 409 path on `PATCH /api/measurements/{id}` is additive (replaces a 500). Both are safe for the iOS client per commit-body claims; spot-checked.

---

## React-Query consistency

- `queryKeys` factory used by `useInsightStatus` and `useInsightsAnalytics`. The new chart-data `queryKey` in `b00be286` is a raw literal array (`["chart-data", types, rangePoints, ..., userTimezone, fetchWindow.from, fetchWindow.to]`) — not routed through `queryKeys`. Six other chart-data keys in the codebase use the same pattern (pre-existing), so this is consistent with the surrounding code but inconsistent with the broader `queryKeys` convention. Worth a v1.4.29 cleanup pass.
- `staleTime` defaults are aligned: 60 s across chart-data, insight-status, analytics. `gcTime` is only set on the chart-data query (5 min). Defaults elsewhere = 5 min Tanstack default. Consistent.
- `retry: 0` on `useInsightStatus` documented. No other query in the diff disables retries. Pairs with the deterministic-fallback shape on the route side (see SD-H3).
- No queryKey collisions detected in this diff. The `["analytics"]` key is shared across the dashboard, the Insights mother page, and the new hook — by design, so the cache unifies. Unwrap shape (`.data` on the envelope) is consistent across the three callers per `feedback_react_query_key_collision.md`.

---

## Sentry / logger / observability

- `annotate(...)` instrumentation lands on the new web-vitals route — names follow the `web_vitals.*` namespace convention. Good.
- `getEvent()?.addWarning(...)` on the dispatch-localised translator-fallback path is preserved. Cache-miss DB errors emit a warning then fall back to `defaultLocale`. Consistent.
- Range-aggregation downsampling path emits `annotate({ meta: { aggregate: grain } })` so downstream analytics can split aggregated vs raw queries. Good.
- **Missing**: the `withTimeout` envelope's `timedOut === true` path on the status routes does **not** emit a Sentry breadcrumb or warning. If 50% of pulse-status calls are timing out, ops has no signal. The routes silently return the no-key fallback text. Recommend wiring `annotate({ meta: { "insight_status.timeout": true, "insight_status.metric": "pulse" } })` on the timeout branch in each of the seven `*-status.ts` routes.
- **Missing**: the new 409 path on `PATCH /api/measurements/{id}` does not annotate the violation. The legacy 500 at least logged the exception. Recommend `annotate({ meta: { "measurement.duplicate_timestamp": true } })` on the catch.

---

## Race-condition checks

| Surface | Concern | Verdict |
|---|---|---|
| `<SubPageShell>` rAF scroll-reset (`ac80c099`) | sub-page unmount → mother-page mount cancel/schedule | Safe — single-threaded JS, cleanup runs before the next mount's effect. See SD-M4 for the effect-deps tweak. |
| `<LayoutCoachFab>` mount + `<CoachLaunchButton>` mount | duplicate FAB in a11y tree | Resolved by the consolidation. Verified: `<CoachLaunchButton>` returns the inline pill only, FAB now lives once at layout root. |
| `withTimeout` promise race | double-resolve | Internal `settled` flag guards against. Clean. |
| LRU cache concurrent reads | two parallel `resolveRecipientLocale("u-1")` cache-miss calls | Both fire `prisma.user.findUnique`, both `localeCache.set(...)`. Second write overwrites first — same value, no harm, one wasted query. Acceptable. |
| Parallel `git add` race documented in `.planning/round-3c-coach-report.md` | working-tree contamination from concurrent commits | Mitigated by explicit-path `git add` per the report. No lost work in the diff; tree is clean against `git log --stat`. |

---

## Summary

**Severity counts**: 2 Critical, 5 High, 7 Medium, 4 Low.

**Top architectural concern**: the unauthenticated, unrate-limited `/api/internal/web-vitals` beacon (SD-C2) and the unaddressed FB-B1 workout-edit save error (SD-C1). The first is a real cost-of-ingestion risk; the second is a maintainer-flagged Critical bug whose mapping to a shipped fix is ambiguous.

**Architectural posture**: the new primitives (`<MetricEmptyState>`, `<HealthChartDynamic>`, `<MobileRailTray>`, `useInsightsAnalytics`, `<HealthScoreDeltaExplainer>`, `<LayoutCoachFab>`) are all legitimate carve-outs from real duplication. The performance fix (bounded fetch window + server-side aggregation) is the right shape; the "All" range semantic narrowing (SD-H1) is the one decision the diff makes silently. The LRU cache pattern is sound; the `withTimeout` helper is reusable. Zero Prisma migrations — clean polish-cycle posture. Two mislabelled commits (SD-H4) cost auditability but no behaviour.

**Recommendation**: **conditional go**. Resolve SD-C1 (reproduce + map or fix FB-B1) and SD-C2 (gate the web-vitals route) before tag. Address SD-H1 (decide the "All" range semantics) before the CHANGELOG goes out — the maintainer may opt for the 365-d narrative or the true-all-time fix. Defer SD-H2/H3/H4/H5 to v1.4.28-final or v1.4.29 depending on cycle headroom. Mediums and Lows ride along.
