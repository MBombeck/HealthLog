/**
 * v1.25.5 — TanStack Query keys for the user-defined custom-metric store.
 *
 * `customMetricEntries` bakes the metric id + sort direction into the key so an
 * infinite-query accumulation never collides with another metric's feed (the
 * project's queryKey-factory invariant). Mutations invalidate `customMetrics()`
 * (the catalog list) and the per-metric detail / entry keys.
 */
export const customMetrics = {
  /** The caller's custom-metric catalog list (with latest value). */
  customMetrics: () => ["custom-metrics"] as const,

  /** A single custom-metric detail. */
  customMetricDetail: (id: string) => ["custom-metrics", "detail", id] as const,

  /** Prefix for invalidating every sorted feed of one custom metric. */
  customMetricEntriesPrefix: (customMetricId: string) =>
    ["custom-metric-entries", customMetricId] as const,

  /** Paginated (offset) value feed for one custom metric. */
  customMetricEntries: (params: { customMetricId: string; sortDir: string }) =>
    ["custom-metric-entries", params.customMetricId, params.sortDir] as const,
};
