/**
 * v1.4.16 — shared chart-mini window vocabulary.
 *
 * The Oura-style RecommendationCard (B5c) embeds a mini-chart that
 * pins to the recommendation's `rationale.dataWindow`. This helper
 * maps the rationale enum onto the calendar-day window used by the
 * existing chart wrappers.
 *
 *   last7days  → 7-day window
 *   last30days → 30-day window
 *   last90days → 90-day window
 *   allTime    → 0 (HealthChart treats 0 as "no window — show all")
 *
 * The values mirror the existing `TIME_RANGES_KEYS` definition in
 * `health-chart.tsx`; the helper is a pure function so unit tests
 * pin the contract without depending on Recharts internals. The
 * exported name keeps the historical `rangePoints` vocabulary because
 * it feeds the chart state/preference field of that name (a persisted
 * wire field) — the VALUE has always been calendar days.
 */

import type { ChartRangePoints } from "@/lib/dashboard/chart-overlay-prefs";

export type DataWindow = "last7days" | "last30days" | "last90days" | "allTime";

const DAYS_BY_WINDOW: Record<DataWindow, ChartRangePoints> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  allTime: 0,
};

/**
 * Returns the day-window value the chart wrapper expects for a given
 * rationale dataWindow enum value.
 */
export function resolveMiniRangePoints(window: DataWindow): ChartRangePoints {
  return DAYS_BY_WINDOW[window];
}
