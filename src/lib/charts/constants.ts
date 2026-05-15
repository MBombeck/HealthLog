/**
 * Shared chart layout constants for the dashboard trend strip.
 *
 * Why a single module: prior to v1.4.27 the three chart files
 * (`health-chart.tsx`, `mood-chart.tsx`, `medication-compliance-chart.tsx`)
 * carried their own hard-coded heights, which drifted apart over time —
 * MoodChart landed on 280 px while every other sibling rendered at 240 px,
 * which broke the vertical rhythm of the trend strip. The constants
 * below give every chart card one source of truth so a future maintainer
 * can retune from one place.
 *
 * Heights are in CSS pixels. Tailwind arbitrary-value classes elsewhere
 * read them as `h-[${CHART_HEIGHT_PX}px]`.
 */

/** Full-size trend-card body height (non-mini chart cards on the dashboard). */
export const CHART_HEIGHT_PX = 240;

/**
 * Range-preset options for charts that expose a 7d / 30d / 90d / All
 * range selector. Each entry carries the i18n keys for the visible
 * label + sr-only title, plus a `points` count used by the underlying
 * `HealthChart` query window. `points: 0` denotes "all data".
 *
 * Re-used by the GLP-1 dashboard tile so its range strip stays in
 * lockstep with the rest of the trend strip.
 */
export const CHART_RANGE_PRESETS = [
  { labelKey: "charts.points7Label", titleKey: "charts.points7Title", points: 7 },
  { labelKey: "charts.points30Label", titleKey: "charts.points30Title", points: 30 },
  { labelKey: "charts.points90Label", titleKey: "charts.points90Title", points: 90 },
  { labelKey: "charts.pointsAllLabel", titleKey: "charts.pointsAllTitle", points: 0 },
] as const;

export type ChartRangePreset = (typeof CHART_RANGE_PRESETS)[number];
