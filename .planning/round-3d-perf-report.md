# v1.4.28 R3d performance + sub-page consolidation report

## Summary

Seven atomic commits landed on `develop`, dispatching every R3d-owned
work item from the v1.4.28 fix-plan. The release-marathon's R1.2
performance hotspots (H4 chart skeletons, H5 locale LRU) were closed,
the insights sub-pages collapsed onto one analytics hook + one
empty-state primitive, the BK-F-M2 `HealthChartDynamic` re-export
retired six duplicated `next/dynamic` call sites, the bundle analyzer
is now opt-in behind `pnpm analyze`, the Web Vitals beacon pipes
client-side CLS/LCP/INP into the existing logging pipeline, and the
`lastYear` coach-window key shipped to all six locales.

BK-M10 (SubPageShell descriptions) was implicitly discharged inside
commit 3: the consolidation refactor populated the description prop on
every empty-state branch as a side effect of the migration to
`<MetricEmptyState>`, so the seventh planned commit collapsed into
commit 3 rather than landing as a separate no-op.

## Commits

| # | SHA | Subject | Discharges |
|---|-----|---------|------------|
| 1 | `d286220b` | `perf(charts): wire chart-skeleton loading state across dynamic imports` | R1.2 H4 |
| 2 | `8f3bfc37` | `refactor(charts): collapse health-chart dynamic imports onto re-export` | BK-F-M2 |
| 3 | `8c89ddac` | `refactor(insights): consolidate sub-page data-fetch and empty state` | BK-F-H1 + BK-F-M1 + BK-MED-4 + BK-M10 |
| 4 | `8f7cbd49` | `fix(insights): document the missing sleep status slot` | BK-UI-StatusSchlaf |
| 5 | `b0ef80dc` | `perf(notifications): cache the dispatch-localised user lookup` | R1.2 H5 |
| 6 | `ebf83b1e` | `feat(perf): wire bundle analyzer and web-vitals beacon` | optional polish |
| 7 | `75773ca0` | `i18n: add the lastYear coach window key` | BK-i18n-lastYear |

## Measured impact

- **Chart skeleton coverage**: 9 of 9 `next/dynamic` chart call sites
  on the R3d-owned surfaces now ship a layout-stable `<ChartSkeleton>`
  loading state. The dashboard `/` + the five `/insights/<metric>`
  sub-pages + `sleep-duration-chart.tsx` are covered. (R1.2 H4 was
  authored against 9 sites; all 9 land.)
- **Dynamic import duplication**: 6 inline `dynamic(() => import(
  "@/components/charts/health-chart")…)` call sites collapsed to one
  `<HealthChartDynamic>` re-export. The dashboard's three other
  charts (`MoodChart`, `MedicationComplianceChart` plus the new
  `HealthChartDynamic`) still use direct `next/dynamic` because they
  back different modules.
- **Insights sub-page consolidation**: 5 sub-pages (`puls`,
  `blutdruck`, `gewicht`, `bmi`, `schlaf`) now share one
  `useInsightsAnalytics()` hook + one `<MetricEmptyState>` primitive.
  Stimmung adopts the primitive only (different fetcher). Medikamente
  was deferred to R3c-Med per the conflict matrix. The duplicated
  `AnalyticsData` interface hoisted to `src/types/analytics.ts`
  (`SubPageAnalyticsData`).
- **`dispatchLocalisedNotification` cache**: 30 s TTL LRU keyed on
  `userId`. Repeat dispatches inside the window share one Prisma
  query — for a burst of admin alerts to the same recipient, this
  collapses N round-trips to 1. The cache is capped at 1 000 entries
  with FIFO eviction.
- **Test coverage**: +5 new tests in
  `src/lib/notifications/__tests__/dispatch-localised-cache.test.ts`
  covering cache hit, TTL expiry, just-inside-TTL, reset helper, and
  per-user isolation.
- **Bundle analyzer**: `pnpm analyze` runs `next build` with
  `@next/bundle-analyzer` enabled; reports land in `.next/analyze/`.
  Zero overhead on the regular `pnpm build` path.
- **Web Vitals beacon**: every `useReportWebVitals` measurement POSTs
  to `/api/internal/web-vitals` via `navigator.sendBeacon` (with a
  `fetch({ keepalive: true })` fallback). The route forwards the
  metric name + value + rating to the wide-event logger via
  `annotate({ meta })`. Internal-only, no persistence, no rate limit.
- **i18n**: `insights.coach.window.lastYear` lands in all six locales
  (`year so far`, `Jahresrückblick`, `depuis le début de l'année`,
  `lo que va de año`, `anno in corso`, `od początku roku`).

## iOS-contract touch

Zero. The only API addition is `POST /api/internal/web-vitals`, which
is browser-internal (called from `navigator.sendBeacon` in
`WebVitalsReporter`). No iOS consumer, no contract change, additive
only.

## Co-ordination notes

- Three parallel R3 contributors actively edited overlapping surfaces
  during this round. Several of my edits had to be re-applied after
  the working tree was reset by parallel git operations — the
  defensive workflow was: edit → stage → commit in tight succession,
  with `pnpm typecheck`/`pnpm lint` running after the commit landed
  rather than gating it.
- Commit `235e52cb` (HEAD~7) was labeled as my commit-2 subject
  ("refactor(charts): single HealthChartDynamic re-export") but the
  actual diff contains R3c-Coach's mobile-rail-tray changes. The
  inversion happened during a concurrent `git commit` race; my real
  BK-F-M2 work landed as `8f3bfc37` with the explicit subject
  `refactor(charts): collapse health-chart dynamic imports onto
  re-export`. The marathon log can flag the mislabeled commit for
  cleanup if needed; functionally the BK-F-M2 work is in place.
