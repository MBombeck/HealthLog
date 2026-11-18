/**
 * v1.9.0 — client-safe range constants and types for the Insights metric
 * pages.
 *
 * The user-selectable range list, its type, the per-range window length, and
 * the period-over-period result shapes are shared between the client (the
 * pills, the delta caption, the range hook, the layout-prefs hook) and the
 * server (`/api/analytics/range` + `range-delta.ts`). This module imports
 * NOTHING server-side — no rollup readers, no `db`, no Prisma client — so the
 * client bundle never transitively pulls `pg` (dns/fs/net/tls) through a range
 * import. The server-only window-composition logic lives in `range-delta.ts`,
 * which re-exports these names for its own callers.
 */

/** The user-selectable ranges. */
export const ANALYTICS_RANGES = ["7d", "30d", "90d", "1y"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

/** Trailing-window length, in days, for each range. */
const RANGE_WINDOW_DAYS: Record<AnalyticsRange, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export function rangeWindowDays(range: AnalyticsRange): number {
  return RANGE_WINDOW_DAYS[range];
}

/** A composed window aggregate. `mean`/etc. are null when the window is empty. */
export interface WindowAggregate {
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
}

export interface RangeDeltaResult {
  range: AnalyticsRange;
  windowDays: number;
  /** The granularity the underlying rollup read resolved against. */
  granularity: string;
  current: WindowAggregate;
  previous: WindowAggregate;
  /**
   * `current.mean - previous.mean`, or null when either window has no mean
   * (no data in the current or prior window) — never a misleading 0.
   */
  delta: number | null;
  /**
   * `delta / previous.mean` as a fraction (0.03 = +3 %), or null when the
   * prior window has no mean / a zero mean (no divide-by-zero, no misleading
   * 0 %). The client renders "no prior-period data" in that case.
   */
  deltaPct: number | null;
  /** The direction of `delta` (#176); see {@link rangeTrend}. */
  trend: RangeTrend;
}

/**
 * A change smaller than this, in the metric's own unit, reads as flat: the
 * floor the metric page already draws its flat arrow and its muted colour at
 * (`getTrendSentiment`).
 */
export const RANGE_TREND_NOISE_FLOOR = 0.05;

export type RangeTrend = "up" | "down" | "flat" | "unknown";

/**
 * The one direction the dashboard tile and the metric page show for a
 * period-over-period `delta` (#176). Before, the tile read its arrow
 * first-to-last off the last seven days while the page compared this month's
 * mean with last month's, so the two could point opposite ways on one visit.
 */
export function rangeTrend(delta: number | null): RangeTrend {
  if (delta === null) return "unknown";
  if (Math.abs(delta) < RANGE_TREND_NOISE_FLOOR) return "flat";
  return delta > 0 ? "up" : "down";
}
