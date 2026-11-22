/**
 * Query keys — dashboard snapshot, widget layout, and analytics reads.
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const dashboardKeys = {
  /**
   * v1.4.33 — the analytics queryKey now optionally carries a
   * `slice` discriminator so the dashboard tile-strip can subscribe to
   * the slim `?slice=summaries` server slice (IW1 / C1) without
   * colliding with the thick-payload consumers on the Insights tree.
   * Calling `queryKeys.analytics()` without a slice keeps the legacy
   * shape `["analytics"]` so mutation invalidations and the bulk-key
   * lists stay byte-identical.
   */
  analytics: (slice?: "summaries") =>
    slice ? (["analytics", slice] as const) : (["analytics"] as const),
  /**
   * v1.9.0 — single-metric period-over-period range read
   * (`GET /api/analytics/range`). A dedicated cache slot per `(type, range)`
   * so switching the time-range pills is a cheap cache hit after the first
   * fetch and never collides with the shared `["analytics", "summaries"]`
   * slot the dashboard tile-strip subscribes to. `["analytics"]` is a prefix
   * so a blanket `queryKeys.analytics()` invalidation still reaches it.
   */
  analyticsRange: (type: string, range: string) =>
    ["analytics", "range", type, range] as const,

  /**
   * The navigation's two counts (`GET /api/nav/counts`): doses and
   * check-ups due now. Evicted with every dose write
   * (`medicationDependentKeys`) and every check-up write
   * (`invalidateReminderReads`, `vaccinationDependentKeys`).
   */
  navCounts: () => ["nav-counts"] as const,
  /**
   * v1.7.0 — unified dashboard first-paint snapshot. One client cell
   * hydrates every above-the-fold tile from `GET /api/dashboard/snapshot`,
   * replacing the four independent analytics-slim / analytics-thick /
   * mood / widget-layout cells. A measurement / mood / medication /
   * widget / insight write evicts the matching server cache bucket via
   * `src/lib/cache/invalidate.ts`; the client read carries the same
   * 60 s `staleTime` as `DASHBOARD_QUERY_OPTS` so a warm return-to-
   * dashboard is a free cache hit.
   *
   * v1.21.3 (b) — optional `locale` segment so a locale switch lands the
   * server-rendered prose (the snapshot carries localised tile copy /
   * narrative text) on its own cache cell instead of serving the prior
   * locale's prose until the slot goes stale. Mirrors the `analytics(slice?)`
   * optional-segment precedent above: a ZERO-ARG call stays byte-identical to
   * the legacy `["dashboard","snapshot"]` literal, so every prefix-based
   * invalidation bundle (`measurementDependentKeys`, `medicationDependentKeys`)
   * and zero-arg reader keeps prefix-matching the locale-keyed cells.
   */
  dashboardSnapshot: (locale?: string) =>
    locale
      ? (["dashboard", "snapshot", locale] as const)
      : (["dashboard", "snapshot"] as const),

  /**
   * v1.4.22 — `["user", "dashboardWidgets"]`
   * was duplicated as a literal at three call sites (dashboard,
   * insights, settings/dashboard-layout). One typo turns into a
   * silent cache miss + extra fetch; the centralised key defends
   * against the same query-key-collision class as `analytics()`.
   */
  dashboardWidgets: () => ["user", "dashboardWidgets"] as const,
};
