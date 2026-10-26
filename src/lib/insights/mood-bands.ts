/**
 * The mood scale's target bands (mirror mood-chart VALUE_BANDS + mood-status).
 *
 * The mood-status generator grades "in target" as score >= 3.5. The
 * mood-chart paints three reference bands (1–2 red, 2–3 orange, 3–5
 * green). We keep both anchored here so the heatmap colour map and the
 * in-target headline never drift from the line chart.
 */
export const MOOD_GREEN_MIN = 3.5;
export const MOOD_GREEN_MAX = 5;
export const MOOD_ORANGE_MIN = 2;
export const MOOD_ORANGE_MAX = 3.5;
