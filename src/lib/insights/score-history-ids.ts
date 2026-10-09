/**
 * The closed set of scores `GET /api/insights/score-history` serves, and the
 * widest window it accepts. Pure constants, apart from the reader, so the
 * OpenAPI registry and the client can import them without the database.
 */
export const SCORE_HISTORY_IDS = [
  "HEALTH_SCORE",
  "READINESS",
  "SLEEP_SCORE",
] as const;
export type ScoreHistoryId = (typeof SCORE_HISTORY_IDS)[number];

/**
 * The widest window a caller may ask for: the chart's "All" tab, the same
 * ten years the metric charts fetch for it. Every score here is one value
 * per day, so the response is bounded by the window, not by row density.
 */
export const SCORE_HISTORY_MAX_DAYS = 3650;
