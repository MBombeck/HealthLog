/**
 * Compute a 7-day trend delta from a metric summary.
 *
 * Backstory — v1.4.15 Fix 4 ("7-Tage-Schnitt" → "7-Tage-Trend"):
 * the dashboard tiles labelled the 7-day average as "7T:" / "7d:"
 * with the mean value beside it. the maintainer found that label unclear
 * (sounded like an "average") when the goal of the tile is to
 * convey *direction* over the past week. We re-use the existing
 * 7-day linear-regression slope (already in `DataSummary.slope7`)
 * and project a stable end-to-end delta as
 *
 *   delta = slope.slope * 7  // units per day → unit delta over 7d
 *
 * The trend-card then paints the delta with metric-aware sentiment
 * colour (up-good vs up-bad).
 *
 * v1.4.16: fall back to slope30 (projected onto 7 days) when
 * slope7 is unavailable. Some metrics (mood, sleep) have <2 entries
 * within the trailing 7-day window for users who don't log daily,
 * which used to surface as a missing delta on the dashboard tile —
 * the maintainer's complaint: "Bei Stimmung wird zum Beispiel kein Trend in
 * Zahlen dargestellt." A 30-day slope still answers the question
 * "is this metric drifting up or down?" — we just project it onto
 * a 7-day window for label consistency. Returning `null` is reserved
 * for the truly insufficient case where neither slope is available.
 *
 * Neither slope reaches this function unless its window earned it: a
 * window whose readings fall on fewer than three days, or cover less than
 * half the window, publishes no slope (`MIN_TREND_DAYS` in
 * `window-confidence.ts`). Before that rule two blood-pressure readings a
 * few minutes apart, the only ones of the week, fitted a slope of thousands
 * of mmHg per day and the tile printed it as the 7-day trend. The 30-day
 * fallback obeys the same rule over its own window.
 *
 * Pure & deterministic — pinned by unit test.
 */
import type { TrendSlope } from "@/lib/analytics/trends";

export interface TrendCapableSummary {
  slope7: TrendSlope | null;
  slope30?: TrendSlope | null;
}

export function summaryToTrend7Delta(
  summary: TrendCapableSummary | undefined | null,
): number | null {
  if (!summary) return null;
  // Primary: trailing-7-day linear-regression slope projected to a
  // 7-day window. slope.slope is units per day (see
  // lib/analytics/trends.ts).
  if (summary.slope7) {
    return summary.slope7.slope * 7;
  }
  // Fallback: slope30 projected onto 7 days. Same units (per day) so
  // we still multiply by 7. This keeps the delta visible for sparser
  // metrics (mood, sleep) that don't accumulate enough points in
  // every trailing 7-day window. The arrow + colour interpretation
  // stays correct because slope30 is computed the same way.
  if (summary.slope30) {
    return summary.slope30.slope * 7;
  }
  return null;
}
