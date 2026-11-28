/**
 * The one answer to "how long after its time does a dose stay on time?".
 *
 * The recurrence engine closes an occurrence's on-time window with it, the
 * cadence walk of the compliance cycle closes the open dose with it, and the
 * medication page names the same number in the plan and in the reminder
 * setting. Before this module the engine fell back to the legacy window span
 * or 60 minutes, the cycle walk to 60 and the page to 30, so a schedule
 * without its own value read three ways. `grace-window-single-rule.test.ts`
 * refuses a second fallback.
 *
 * Pure string arithmetic, safe in both bundles.
 */
import { hhmmToMinutesOrNull } from "@/lib/medications/scheduling/hhmm";

/** The fallback when neither the schedule nor its legacy window says. */
export const DEFAULT_GRACE_MINUTES = 60;

/**
 * The schedule's on-time window in minutes:
 *
 *   - `reminderGraceMinutes` when set on the schedule;
 *   - else the legacy `windowEnd - windowStart` span (an overnight window
 *     wraps to the next day);
 *   - else `DEFAULT_GRACE_MINUTES` (a missing literal, or a single-time
 *     window like "08:00..08:00").
 */
export function effectiveGraceMinutes(schedule: {
  reminderGraceMinutes?: number | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}): number {
  if (
    schedule.reminderGraceMinutes !== null &&
    schedule.reminderGraceMinutes !== undefined
  ) {
    return schedule.reminderGraceMinutes;
  }
  const startMin = hhmmToMinutesOrNull(schedule.windowStart ?? "");
  const endMin = hhmmToMinutesOrNull(schedule.windowEnd ?? "");
  if (startMin === null || endMin === null) return DEFAULT_GRACE_MINUTES;
  let span = endMin - startMin;
  if (span < 0) span += 24 * 60;
  return span === 0 ? DEFAULT_GRACE_MINUTES : span;
}
