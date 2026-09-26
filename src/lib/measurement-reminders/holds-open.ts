/**
 * v1.39.2 — whether a reminder stays due after it is sent.
 *
 * Decided by the cycle length, not by what the reminder asks for. A reminder
 * whose next slot is more than {@link HOLD_OPEN_MIN_CYCLE_DAYS} days after the
 * current one stays due until it is satisfied (a matching reading or lab
 * result, or "done"), skipped or snoozed: rolling it on would file an open
 * task under a slot weeks or a year away. That holds for free-text check-ups
 * and measurement reminders alike; the report that led here was a fortnightly
 * PHQ-9 and GAD-7 pair. A reminder with no cadence, or a rule with no
 * occurrence left, has no next slot and also stays due: its last slot is the
 * task. A weekly or shorter cycle rolls on, because its next slot is the next
 * reminder anyway, and holding a daily course on a missed slot would stall it.
 * An appointment (`ENCOUNTER`) is always one-shot.
 *
 * The one definition. The reminder tick decides with it whether a delivered
 * reminder rolls on; the daily digest decides with it whether a reminder due
 * later today belongs on the start page already and keeps its place there;
 * the edit route decides with it whether re-enabling keeps the open slot.
 *
 * A course window (`endsOn`) is deliberately not consulted: it ends a
 * Coach-suggested measurement course, which is a short-cycle rhythm and rolls
 * on regardless.
 */
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";
import { computeReminderNextDueAt } from "@/lib/measurement-reminders/scheduling";

/** A cycle of at most this many calendar days rolls on after its reminder. */
export const HOLD_OPEN_MIN_CYCLE_DAYS = 7;

export interface HoldOpenInput {
  origin?: string | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  lastSatisfiedAt: Date | null;
  createdAt: Date;
}

/**
 * `slot` is the instant of the current slot: the send instant in the tick
 * (a few seconds past the occurrence it sends), the stored `nextDueAt`
 * elsewhere. For a rule the cycle is the calendar-day gap between its next
 * two occurrences from `slot` on, so the answer does not depend on where
 * between two occurrences `slot` sits. With one occurrence left the gap is
 * measured from `slot` to it; with none left the reminder holds open.
 */
export function holdsOpenAfterReminder(
  reminder: HoldOpenInput,
  timezone: string,
  slot: Date,
): boolean {
  if (reminder.origin === "ENCOUNTER") return false;
  if (reminder.intervalDays !== null) {
    return reminder.intervalDays > HOLD_OPEN_MIN_CYCLE_DAYS;
  }
  if (reminder.rrule === null) return true;
  const input = {
    intervalDays: null,
    rrule: reminder.rrule,
    anchorDate: reminder.anchorDate,
    notifyHour: reminder.notifyHour,
    lastSatisfiedAt: reminder.lastSatisfiedAt,
    createdAt: reminder.createdAt,
  };
  // At or after `slot`: a stored slot sits exactly on an occurrence.
  const first = computeReminderNextDueAt(
    input,
    timezone,
    new Date(slot.getTime() - 1),
  );
  if (first === null) return true;
  const second = computeReminderNextDueAt(input, timezone, first);
  if (second === null) {
    // `slot` is the last occurrence: nothing to roll on to.
    if (first.getTime() <= slot.getTime()) return true;
    return calendarDaysUntil(first, slot, timezone) > HOLD_OPEN_MIN_CYCLE_DAYS;
  }
  return calendarDaysUntil(second, first, timezone) > HOLD_OPEN_MIN_CYCLE_DAYS;
}
