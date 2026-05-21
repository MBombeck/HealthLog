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
