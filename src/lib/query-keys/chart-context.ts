/**
 * Query keys — the context marks on metric charts (`GET /api/insights/context`).
 * Part of the centralized factory; aggregated in `./index.ts`.
 *
 * The key sits under the `["timeline"]` root on purpose: the marks are the
 * timeline's own medication, illness and cycle lanes, and every write to
 * those tables already evicts that root through the data bundles in
 * `./index.ts`, so a dose change shows on the chart the moment it is saved.
 */
export const chartContextKeys = {
  /** `GET /api/insights/context`, the whole record (the chart cuts its window). */
  chartContext: () => ["timeline", "chart-context"] as const,
};
