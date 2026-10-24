/**
 * Shared window-confidence helper (v1.17 W1b).
 *
 * Several insight tiles narrate a metric over a fixed trailing window —
 * the BD-Zielbereich tile reports the BP in-target share over the last
 * 90 days, and future tiles (glucose TIR / GMI, sleep efficiency, …)
 * will do the same over their own windows. A static "· 90 T" label is
 * dishonest for a user who has only a few weeks of history or only a
 * handful of readings: the headline reads like a stable quarter-long
 * average when it is really a thin sample.
 *
 * This helper turns a window length + the readings observed inside it
 * into two truthful signals every windowed tile can reuse:
 *
 *   1. `effectiveSpanDays` — the real calendar span of the data, capped
 *      at the window. A user with 23 days of history sees "· 23 T"; once
 *      ~90 days of history exist the span saturates at the window and the
 *      label reads "· 90 T". `null` when the window holds no readings.
 *
 *   2. `sufficient` — `false` when fewer than `MIN_READINGS_FOR_CONFIDENCE`
 *      readings fall in the window. The caller renders a "collecting data"
 *      placeholder instead of a confident percentage, and the Health-Score
 *      pillar treats the metric as absent rather than grading a thin sample.
 *
 * Pure & deterministic so the unit suite can pin both outputs.
 */

/**
 * Minimum readings inside the window before a percentage is trustworthy.
 * Below this the tile narrates "collecting data" and the score pillar is
 * suppressed. Five is the same floor the trend cards use before they draw
 * a first slope — a sample small enough to be noise.
 */
export const MIN_READINGS_FOR_CONFIDENCE = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `true` once a window holds enough readings to narrate a confident
 * percentage. Shared by the server (Health-Score pillar gate) and the
 * client (tile placeholder) so both apply the identical floor.
 */
export function isWindowSufficient(readingCount: number): boolean {
  return readingCount >= MIN_READINGS_FOR_CONFIDENCE;
}

export interface WindowConfidence {
  /**
   * Real calendar span of the in-window data, in days, capped at
   * `windowDays`. `null` when the window holds no readings (caller renders
   * the "—" / placeholder rather than "· 0 T").
   */
  effectiveSpanDays: number | null;
  /** `true` once at least `MIN_READINGS_FOR_CONFIDENCE` readings exist. */
  sufficient: boolean;
}

/**
 * v1.17 — derive the BD-Zielbereich tile's confidence inputs (90-day
 * pair count + effective label span) from a BP envelope's 90-day window.
 * Shared by the dashboard snapshot and the `/api/analytics` thick slice so
 * the two surfaces can never compute the tile's gate or span differently.
 */
export function deriveBpWindow90(
  last90: { pairs: number } | null,
  last90EarliestAt: Date | null,
  now: Date,
): { count: number; spanDays: number | null } {
  const count = last90?.pairs ?? 0;
  const spanDays = computeWindowConfidence({
    windowDays: 90,
    readingCount: count,
    earliestReadingAt: last90EarliestAt,
    now,
  }).effectiveSpanDays;
  return { count, spanDays };
}

/**
 * Compute the effective label span + sufficiency flag for a windowed
 * metric.
 *
 * @param windowDays         the configured trailing window (e.g. 90).
 * @param readingCount       number of readings counted inside the window.
 * @param earliestReadingAt  timestamp of the oldest in-window reading, or
 *                           `null` when the window is empty. The span is
 *                           `now - earliest`, ceil-rounded to whole days,
 *                           and never exceeds `windowDays`. At least 1 day
 *                           so a same-day-only sample still reads "· 1 T".
 * @param now                clock anchor (injectable for deterministic tests).
 */
export function computeWindowConfidence(input: {
  windowDays: number;
  readingCount: number;
  earliestReadingAt: Date | null;
  now?: Date;
}): WindowConfidence {
  const { windowDays, readingCount, earliestReadingAt } = input;
  const now = input.now ?? new Date();

  const sufficient = isWindowSufficient(readingCount);

  if (readingCount <= 0 || earliestReadingAt === null) {
    return { effectiveSpanDays: null, sufficient };
  }

  const rawSpanMs = now.getTime() - earliestReadingAt.getTime();
  // A reading logged moments ago still spans one calendar day of history.
  const rawSpanDays = Math.max(1, Math.ceil(rawSpanMs / DAY_MS));
  const effectiveSpanDays = Math.min(rawSpanDays, windowDays);

  return { effectiveSpanDays, sufficient };
}

/**
 * Minimum evidence before a trailing window may report a TREND.
 *
 * Every windowed trend (`slope7` / `slope30` on a summary, the per-bucket
 * slope of a coarse rollup bucket) is a least-squares slope in units per
 * DAY. When the window's readings sit close together in time — two blood
 * pressure readings a few minutes apart being the only ones of the week —
 * the x-span is a few minutes, the slope per day explodes, and the 7-day
 * projection the dashboard tile prints reads as thousands of mmHg. A reading
 * count cannot catch this (`isWindowSufficient` admits five readings taken
 * in one sitting), so the trend gate is about time, not count:
 *
 *   1. the readings fall on at least `MIN_TREND_DAYS` distinct days, and
 *   2. the first and last of those days lie at least half the window apart
 *      (`minTrendSpanDays`): 4 days for a 7-day window, 15 for a 30-day one.
 *
 * Why these two. A least-squares slope is the (Δx)²-weighted average of the
 * slopes between every pair of readings, so once readings days apart exist,
 * a same-session cluster carries almost no weight; the span floor guarantees
 * such pairs exist and bounds how far a 7-day projection reaches beyond what
 * was observed. Three days is the least that lets the fit tell a trend from
 * a two-cluster difference: through two days a line fits perfectly and its
 * R² says nothing. The same days-plus-span shape gates the medication
 * segmented-effect fit (`SEGMENTED_MIN_DAYS_PER_SIDE` / `_SPAN_DAYS`).
 *
 * The fit itself stays over the individual readings, as it was: the window
 * means beside it (`avg7` / `avg30`) average readings too, and the rollup
 * accumulators the warm path composes from are per reading. The gate
 * decides only whether the window has earned a slope at all.
 *
 * Days are UTC calendar days: the rollup tier and the live SQL bucket by UTC
 * day, and the gate must give the same answer on the JS, rollup and live
 * paths, or a coverage transition would flip a tile's trend on and off.
 */
export const MIN_TREND_DAYS = 3;

/** How many days the trend evidence in a window covers. */
export interface TrendEvidence {
  /** Distinct UTC calendar days in the window that hold a reading. */
  days: number;
  /** Whole UTC days between the first and the last of those days. */
  spanDays: number;
}

/** The least first-to-last span a window's readings must cover for a trend. */
export function minTrendSpanDays(windowDays: number): number {
  return Math.ceil(windowDays / 2);
}

/** `true` once a window's readings may carry a trend (see `MIN_TREND_DAYS`). */
export function isTrendWindowSufficient(
  evidence: TrendEvidence,
  windowDays: number,
): boolean {
  return (
    evidence.days >= MIN_TREND_DAYS &&
    evidence.spanDays >= minTrendSpanDays(windowDays)
  );
}

/**
 * The trend evidence of a set of instants (epoch milliseconds): how many
 * distinct UTC days they fall on and how many days lie between the first and
 * the last of them.
 */
export function trendEvidenceOf(instantsMs: Iterable<number>): TrendEvidence {
  let first = Infinity;
  let last = -Infinity;
  const days = new Set<number>();
  for (const ms of instantsMs) {
    const day = Math.floor(ms / DAY_MS);
    days.add(day);
    if (day < first) first = day;
    if (day > last) last = day;
  }
  if (days.size === 0) return { days: 0, spanDays: 0 };
  return { days: days.size, spanDays: last - first };
}
