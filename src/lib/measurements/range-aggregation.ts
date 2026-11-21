/**
 * v1.4.28 (R1.2 H0) — server-side range aggregation for the
 * health-chart pipeline.
 *
 * Before: every chart navigation issued an unbounded `while (true)`
 * paginated walk of `/api/measurements?type=…` from the client and
 * bucketed the rows daily in the browser. For Apple-Health-rich
 * accounts (pulse every minute, months of history) this was tens of
 * thousands of rows per type per page visit.
 *
 * After: the read hands back one row per bucket per type at the grain
 * the window calls for. The downsampling keeps the chart's visual
 * fidelity (one point per visible bucket) while bounding the payload
 * regardless of underlying density.
 */

export type AggregateGrain = "raw" | "daily" | "weekly" | "monthly";

/**
 * Maximum bucket count per grain. Bounds the aggregated response shape
 * so a multi-year window never paints more buckets than the chart can
 * reasonably absorb. Applied after bucketising, NOT before — the SQL
 * aggregation always sees the full row set inside the window.
 */
export const BUCKET_CAP: Record<Exclude<AggregateGrain, "raw">, number> = {
  daily: 365,
  weekly: 105, // ~2 years of weeks; the monthly grain kicks in past 730 d
  monthly: 24,
};
