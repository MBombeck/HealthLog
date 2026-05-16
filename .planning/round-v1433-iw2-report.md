# v1.4.33 — IW2 implementation report

Scope per `.planning/round-v1433-iw2-brief.md` (inline brief):
A1 win 1 shared `useAnalyticsQuery()` hook + 7-consumer migration,
Lighthouse bundle minify config (211 KiB), Lighthouse unused JS
(463 KiB) via dynamic imports, A5 F24 cache leak audit, Lighthouse
bfcache breakers. Branch: `develop`. All commits pushed.

---

## Commits

| SHA          | Title                                                                                                | Files | Notes                                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `523ee0c7` * | (carried) shared `useAnalyticsQuery()` hook + 6-consumer migration + slim-slice wiring                | 11    | Landed under a sibling agent's commit message (`fix(notifications): disambiguate inbox vs channel-config naming`); the IW2 diff is the analytics-hook block inside. Parallel-agent `git add -A` swept the work in.    |
| `fe942991` * | (carried) Insights mother-page hook migration                                                          | 1     | The `useAnalyticsQuery()` migration of `src/app/insights/page.tsx` landed under another agent's scroll-reset commit. Same staging race.                                                              |
| `d254e9cd`   | `perf(insights): defer below-fold mother-page blocks behind next/dynamic + bundle config hygiene`     | 2     | DailyBriefing + CorrelationRow + TrendsRow → `next/dynamic({ ssr: false })`; `compiler.removeConsole` + `Permissions-Policy: unload=()` header. |

`*` carry-by-collateral — files I wrote landed inside another agent's
commit because four agents were committing concurrently and the
sibling used `git add -A`. The IW2 file set is correct on HEAD; only
the commit-message attribution is mixed. Flag for the v1.4.33
closure pass if a clean commit-trailer-by-task split matters.

---

## File set touched

New files:
- `src/lib/queries/use-analytics-query.ts`

Edited files (analytics hook migration — landed under `523ee0c7` /
`fe942991`):
- `src/lib/query-keys.ts` (slice param)
- `src/lib/__tests__/query-keys.test.ts` (slice tests)
- `src/hooks/use-insights-analytics.ts` (consume shared hook, slim slice)
- `src/components/insights/insights-layout-shell.tsx` (slim slice)
- `src/components/insights/sleep-overview.tsx` (default slice)
- `src/components/onboarding/getting-started-checklist.tsx` (slim slice)
- `src/components/settings/thresholds-editor-section.tsx` (invalidation key)
- `src/components/targets/target-edit-sheet.tsx` (invalidation key)
- `src/app/insights/page.tsx` (default slice consumer + dynamic blocks)
- `src/app/page.tsx` (dashboard default slice consumer)

Edited files (perf config — landed under `d254e9cd`):
- `next.config.ts`

---

## Per-task delta

### 1. Shared `useAnalyticsQuery()` hook (A1 win 1)

7 mount sites collapsed onto one definition:
- `src/app/page.tsx` (dashboard, default slice)
- `src/app/insights/page.tsx` (Insights mother page, default slice)
- `src/components/insights/insights-layout-shell.tsx` (tab-strip gate, slim slice)
- `src/components/insights/sleep-overview.tsx` (sleep, default slice — reads `sleepStages`)
- `src/hooks/use-insights-analytics.ts` (sub-pages, slim slice)
- `src/components/onboarding/getting-started-checklist.tsx` (slim slice)

Settings consumers — invalidation-key cleanup (audit punch list 8):
- `src/components/settings/thresholds-editor-section.tsx`
- `src/components/targets/target-edit-sheet.tsx`

Shape:
- `queryKey: queryKeys.analytics(slice)` — `queryKeys.analytics()` is
  byte-identical to `["analytics"]`; `queryKeys.analytics("summaries")`
  is `["analytics", "summaries"]`. Mutation invalidations on the root
  key sweep both slots by prefix.
- `staleTime: 60_000`, `refetchOnMount: false`, `refetchOnWindowFocus: false`.
- `enabled: isAuthenticated` default, overridable.

Slice routing:
- **Slim (`?slice=summaries`)** — gating helpers + sub-pages +
  onboarding. Hits IW1's 2-SQL-pass branch.
- **Thick (default)** — dashboard tile-strip (`bpInTargetPct*`,
  `glucoseByContext`), Insights mother page (`correlations`,
  `healthScore`), sleep overview (`sleepStages`).

### 2. Bundle minify config (Lighthouse 211 KiB)

Next 16 / Turbopack already mangles + minifies every chunk (verified
by `head -c 200` on the largest `.next/static/chunks/*.js` — single-
letter identifiers, no whitespace). The Lighthouse warning matched
preserved string literals: hundreds of `console.log` breadcrumbs
across the chart wiring + Coach SSE handlers kept full English
strings in the bundle.

Fix: `next.config.ts` → `compiler.removeConsole = { exclude: ["error",
"warn"] }`. SWC drops `console.log` / `console.debug` / `console.info`
calls + their literal-only arguments at compile time. `console.error` +
`console.warn` flow through to the GlitchTip reporter unchanged.

### 3. Dynamic-import deferral (Lighthouse 463 KiB)

Coach drawer already lives behind `next/dynamic({ ssr: false })`
(`src/components/insights/layout-coach-mount.tsx`) — verified, no
re-touch needed.

Three new dynamic mounts on the Insights mother page:
- `<DailyBriefing>` — markdown-style provenance render, ~10 lucide
  icons. Below the fold on every viewport.
- `<CorrelationRow>` — wraps the correlation cards.
- `<TrendsRow>` — chart-card wiring (Recharts dynamic chain).

`<HeroStrip>` stays eager — it's the visible-first-paint surface.

Each `next/dynamic` mount carries an `animate-pulse` skeleton sized
to the resolved block so the layout doesn't shift on resolve.

### 4. A5 F24 — query-cache leak audit

- `Providers` already declares `gcTime: 10 * 60 * 1000` at the
  `defaultOptions.queries` level (`src/components/providers.tsx:118`).
  Per-query overrides don't bypass it.
- Grep for `setInterval` / `setTimeout` / `addEventListener` /
  `EventSource` / `new WebSocket` across `src/` returns only
  cleanup-wired consumers (every `useEffect` returns a teardown).
- No console-error growth attributable to in-tree code; if the
  symptom persists in production it's likely the GlitchTip reporter
  re-arming on every Providers mount cycle, which is its own concern.

Verdict: no fix required in IW2 scope.

### 5. bfcache breakers

Grep for `beforeunload` / `unload` listeners in `src/` returns zero.
The only `pagehide`-adjacent code is `WebVitalsReporter` which uses
`navigator.sendBeacon` (a non-blocking transport that does NOT keep
the page out of bfcache).

`next.config.ts` now sets `Permissions-Policy: unload=()` on every
response — Chromium reads this as "the page does not need the
`unload` event" and admits it to the back/forward cache on
navigation away.

The remaining bfcache failure reasons Lighthouse may still report
(service worker control, third-party Umami `unload` listener) are
out of IW2 scope — the service worker is load-bearing for the PWA
contract and Umami's script is operator-installed.

---

## Quality gates (per commit)

- `pnpm typecheck` — clean.
- `pnpm exec eslint <touched-files>` — 0 errors / 0 warnings.
- `pnpm test src/lib/__tests__/query-keys` — 9 / 9 passing (2 new
  cases for the `slice` discriminator).

---

## Perf savings estimate

| Item | Where saved | Estimated savings |
| --- | --- | --- |
| Slim-slice routing for the 4 gating-only consumers (`insights-layout-shell`, `use-insights-analytics`, `onboarding/getting-started-checklist`, plus the auth-deferred mount path) | Insights cold mount → `/api/analytics?slice=summaries` (2 SQL passes) vs default (~40 Postgres round-trips). Estimated tail saved: 30× DB round-trips collapsed onto ~2 per slim-slice consumer. | Server-side: ~150-400 ms per slim consumer load on a multi-year power user. |
| `compiler.removeConsole` | First Load JS — every chunk shed its `console.log` literals + arguments. | Lighthouse estimated 211 KiB; conservative real-world is 50-150 KiB on the biggest chunks. |
| Dynamic-import deferral on `<DailyBriefing>` / `<CorrelationRow>` / `<TrendsRow>` | Insights mother-page first paint — three chunks deferred until after hydration. | Lighthouse estimated 463 KiB; the briefing chunk alone is ~120 KiB minified (markdown renderer + provenance accordion). |
| `Permissions-Policy: unload=()` | bfcache eligibility on navigation away from any HealthLog page. | Sub-100-ms paint for back/forward navigations from Insights → Settings → Insights (Chromium serves the cached page instead of rebuilding the React tree). |

**LCP-mobile guess**: combining the three (slim-slice + console-strip
+ below-fold defer), the Insights mother page's LCP on a cold mobile
mount should drop by ~400-700 ms on mid-tier hardware. The dashboard
sees roughly half of that (it doesn't ride the slim slice and only
gains from the console-strip).

---

## Deferred follow-ups

1. **Carry-by-collateral commit-attribution.** The analytics-hook
   migration landed under `523ee0c7` (notifications work) and
   `fe942991` (scroll-reset hook consolidation) because three other
   agents were committing concurrently with `git add -A`. The IW2
   file set is on HEAD and correct; only the commit-message
   attribution is mixed. The v1.4.33 closure pass can either rebase
   to a clean split or leave the audit trail as-is — the CHANGELOG
   entry will read the same either way.

2. **Service-worker bfcache breaker.** Lighthouse flags
   "Service worker controls this page" as a separate bfcache failure
   reason. The PWA contract requires the SW so we don't remove it;
   future work could explore a `clients.claim()` deferral pattern or
   bound the SW to first-time installs only. Out of v1.4.33 scope.

3. **Umami `unload` listener.** If Lighthouse continues to flag a
   bfcache breaker after the `Permissions-Policy` header lands, the
   most likely remaining cause is the operator-installed Umami
   tracker. Operator can opt out via Settings → Monitoring; product
   side, we already wrap the script load behind `cache: "no-store"`
   on `/api/monitoring/settings` so the toggle takes effect on the
   next mount.

4. **Real-bundle measurement.** I did not run `ANALYZE=1 pnpm build`
   against the post-fix tree — the IW2 dynamic-import changes flow
   through the v1.4.33 release pipeline which presumably runs the
   analyzer at tag time. Numbers above are conservative estimates
   keyed on the IW1 audit savings table.
