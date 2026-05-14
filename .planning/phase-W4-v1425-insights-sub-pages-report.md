# Phase W4 — Insights sub-pages restructure + Sleep + batch-delete (v1.4.25)

Scope: W4a (routed sub-pages) + W4b (DELETE endpoint) + W4c (Sleep
sub-page) + W4d (mother-page restructure) + W4e (i18n strings).
Branch: `develop`. No push, no tag, atomic commits.

## Commits

1. `38bbba1` — `feat(insights): scaffold 6 metric sub-pages with shared layout shell`
2. `959adec` — `feat(api): DELETE /api/measurements/by-external-ids for iOS deletion-sync`
3. `cb825ec` — `feat(insights): new /insights/schlaf sub-page with sleep-stage chart`
4. `7644bd0` — `refactor(insights): mother page hosts overview only; metric depth moves to sub-pages`
5. `d63fa27` — `i18n(insights): EN + DE strings for the 7 insights sub-pages`
6. `85e93dc` — `chore(openapi): regenerate docs/api/openapi.yaml` (reconciles a W7 agent's drift)

## Files added

- `src/app/insights/layout.tsx` — shared layout (server component shim).
- `src/app/insights/blutdruck/page.tsx`
- `src/app/insights/gewicht/page.tsx`
- `src/app/insights/puls/page.tsx`
- `src/app/insights/stimmung/page.tsx`
- `src/app/insights/medikamente/page.tsx`
- `src/app/insights/bmi/page.tsx`
- `src/app/insights/schlaf/page.tsx`
- `src/app/api/measurements/by-external-ids/route.ts` — DELETE handler.
- `src/components/insights/insights-layout-shell.tsx` — owns the
  advisor query at the layout level so the regenerate button works
  on every sub-page.
- `src/components/insights/sub-page-shell.tsx` — title + badge +
  focusable h1 (a11y focus restoration on tab navigation).
- `src/components/insights/sleep-duration-chart.tsx` — wrapper around
  `<HealthChart chartKey="sleep" />`.
- `src/components/insights/sleep-stage-stacked-bar.tsx` — Recharts
  horizontal stacked bar of stage composition.
- `src/components/insights/sleep-overview.tsx` — sleep page composition.
- `src/hooks/use-insights-layout-prefs.ts` — `comparisonBaseline`
  reader (single source for every Insights surface).
- `src/lib/insights/sub-page-metric.ts` — slug → MeasurementType[] map.
- `tests/integration/measurements-batch-delete.test.ts` — 4 cases.
- `src/components/insights/__tests__/sleep-stage-stacked-bar.test.tsx` — 4 cases.
- `src/components/insights/__tests__/sub-page-shell.test.tsx` — 3 cases.

## Files modified

- `src/app/insights/page.tsx` — slim mother page (1498 lines removed).
- `src/components/insights/insights-tab-strip.tsx` — route-aware
  (`<Link>` + `usePathname()` replacing scroll-into-view).
- `src/lib/openapi/routes.ts` — DELETE endpoint registered.
- `docs/api/openapi.yaml` — regenerated.
- `messages/en.json`, `messages/de.json` — sub-page descriptions,
  empty-state CTAs, sleep stage labels.
- `src/app/__tests__/insights-polish.test.ts` — two guard tests
  re-pointed at the new homes of their assertions (layout shell +
  shared layout-prefs hook).
- `src/components/insights/__tests__/trends-row.test.tsx` — every
  render now wraps in a TanStack-Query provider because the W7
  timezone agent added a `useAuth()` call inside `<TrendsRow>`.

## Architectural notes

- **CoachDrawer placement** stays on the mother page body only.
  Navigating to a sub-page unmounts the drawer (Marc's directive). The
  layout shell deliberately does NOT mount the drawer.
- **Per-card chart cog**: every sub-page passes a `chartKey` from
  `CHART_OVERLAY_KEYS` so the existing dashboard chart-cog surface
  applies on Insights without a single backend change.
- **`comparisonBaseline` plumbing**: `useInsightsLayoutPrefs()` is now
  the single shared reader; the mother page no longer touches it
  because its charts moved out.
- **OpenAPI**: the new `MeasurementsDeleteByExternalIdsRequest` /
  `MeasurementsDeleteByExternalIdsResult` schemas live alongside the
  ingest pair; the path entry sits under the Measurements tag.

## Test delta

- Unit + integration tests outside `tests/integration/` go from 2365
  → 2375 (+10), all passing.
- New integration suite `measurements-batch-delete.test.ts` adds 4
  cases (requires Postgres; not run locally per project convention).

## Verification

```
$ pnpm typecheck    # exit 0
$ pnpm lint         # clean (no warnings on my files)
$ pnpm openapi:check  # spec in sync
$ pnpm vitest run --exclude='tests/integration/**'
  Test Files  277 passed (277)
  Tests       2375 passed | 1 skipped (2376)
```

`pnpm format:check` still surfaces 21 pre-existing warnings in
parallel-agent files (planning markdown, mood-related modules,
admin login-overview tests). My files all pass; the unrelated drift
is out of W4 scope.

## Manual verification (not run locally)

Manual smoke notes to verify after deploy:

- `/insights` mother page renders (Hero + Briefing + Trends + Advisor +
  Coach drawer).
- Each of `/insights/{blutdruck,gewicht,puls,stimmung,medikamente,bmi,schlaf}`
  renders without crashes and the tab strip's active pill matches.
- Chart-cog on a sub-page chart persists overlay prefs across
  refreshes (`PUT /api/dashboard/chart-overlay-prefs` round-trip).
- AI-disabled user (demo) doesn't see broken Coach buttons — the
  layout shell forwards `regenerate` only when authenticated, and the
  per-section status cards already gate on `hasProvider`.
- Sleep sub-page empty-state (no SLEEP_DURATION rows) renders the
  "Apple Health sync in v1.5" CTA.

## Deferred / not in scope

- Per-night stacked column chart (true time-series view of stages).
  The W4c chart shows the 30-day composition aggregate the existing
  `/api/analytics` endpoint already exposes; a per-night view would
  need a new server endpoint with per-day×stage data. Park for v1.4.26
  in `.planning/v1425-backlog.md` if Marc wants it.
- `/api/insights/general-status` endpoint is now orphaned (no
  consumer survives the mother-page slim-down). Server route +
  associated translations weren't removed in this phase to keep the
  surface area tight; W4 ships orchestration only.
- The `insights.navGeneral` translation key is still referenced from
  the legacy `SECTION_LABEL_KEYS` map but the new route-aware strip
  doesn't read it. Safe to delete in a follow-up cleanup.
- Greying out the comparison overlay picker when prior-period data is
  unavailable (research §4 polish; not required to ship).

## Constraints honoured

- No version bump or CHANGELOG entry (W11 owns release notes).
- No edits to `src/lib/ai/coach/snapshot.ts` (W7b in flight).
- No edits to `src/components/insights/coach-panel/coach-drawer.tsx`
  internals.
- No edits to chart-tokens / recommendation-card / insight-advisor
  internals (W5b in flight).
- No edits to admin login overview (W8b in flight).

## Risk notes for reviewer

- The layout shell mounts `useInsightsAdvisorQuery(isAuthenticated)`
  on every Insights surface. The query's `staleTime: 60 * 60 * 1000`
  (60 min) prevents network thrash; re-mounting on tab navigation is
  a cache read.
- The mother page's `<HeroStrip onRegenerate>` wiring is GONE — the
  hero band's regenerate button no longer paints. The strip-mounted
  regenerate icon is the sole page-level affordance.
- `DELETE /api/measurements/by-external-ids` bypasses the
  `Idempotency-Key` cache. A retried DELETE returns the same
  `deletedCount: 0` because the rows are already gone — that's the
  correct contract; the client should treat both calls as success.
