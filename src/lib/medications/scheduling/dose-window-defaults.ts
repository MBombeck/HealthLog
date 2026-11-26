/**
 * Default on-time / overdue window widths for the compliance engine.
 *
 * Kept in its own leaf module — free of any server-only import — so the
 * client-side dose-window editor can read the same defaults without
 * pulling the full analytics graph (and its `node:async_hooks` deps)
 * into the browser bundle. `@/lib/analytics/compliance` re-exports this
 * constant so existing server-side imports keep their path.
 *
 * DAILY / INTRADAY dose (minute-scale windows):
 *   - on-time:    target ± 1h
 *   - overdue:    up to target + 4h  (late-but-counts)
 *   - missed:     > target + 4h
 *
 * WEEKLY / ROLLING injectable (day-scale windows; the 4-day clinical rule):
 *   - on-time:    target day ± 1 day
 *   - overdue:    up to target + 4 days  (late-but-counts)
 *   - missed:     > target + 4 days
 */
export const DOSE_WINDOW_DEFAULTS = {
  /** Daily / intraday on-time half-width around the target instant (min). */
  dailyOnTimeMinutes: 60,
  /**
   * Bounded early grace ahead of a dose's on-time window (min). A take up
   * to this far before the window start still credits the slot (the
   * attribution caps the reach at the previous slot's overdue end).
   * Single source for the write-path attribution AND the card pill's
   * last-intake suppression, so the two can never disagree on how early
   * a take may land.
   */
  earlyGraceMinutes: 60,
  /**
   * Daily / intraday overdue tail past the on-time window (min). A dose
   * taken inside `[onTime, onTime + overdue]` still counts; beyond it the
   * dose is missed.
   */
  dailyOverdueMinutes: 240 - 60,
  /** Weekly / rolling on-time half-width around the target day (days). */
  weeklyOnTimeDays: 1,
  /**
   * Weekly / rolling overdue tail past the target day (days) — the clinical
   * 4-day GLP-1 rule. A shot inside `[target, target + 4d]` still counts;
   * beyond it the dose is missed and the user skips to the next slot.
   */
  weeklyOverdueDays: 4,
} as const;

/**
 * How far ahead of its anchor a daily dose becomes takeable: the on-time
 * half-window plus the early grace, two hours. The Today card surfaces a dose
 * from this moment (`DOSE_DUE_LOOKAHEAD_MS`).
 */
export const DAILY_TAKEABLE_AHEAD_MS =
  (DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes +
    DOSE_WINDOW_DEFAULTS.earlyGraceMinutes) *
  60_000;
