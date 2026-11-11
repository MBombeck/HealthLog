/**
 * v1.39.2 — whether a reminder stays due after it is sent.
 *
 * A reminder that stays due is not moved by its reminder: it keeps its due
 * date until it is satisfied (a matching reading or lab result, or "done"),
 * skipped or snoozed, so every surface reads it as due and then overdue.
 *
 *   - A rolling interval (`intervalDays`) always stays due. It is anchored on
 *     its last satisfaction, so its next slot does not exist until it is
 *     satisfied; rolling it on after a reminder re-anchored it on the send,
 *     and a missed every-two-days blood pressure reading read "in 2 days"
 *     each evening and was never shown as due or overdue.
 *   - A calendar rule (`rrule`) stays due when its next occurrence is more
 *     than {@link HOLD_OPEN_MIN_CYCLE_DAYS} days away: rolling it on would
 *     file an open task under a slot weeks or a year away. That holds for
 *     free-text check-ups and measurement reminders alike; the report that
 *     led here was a fortnightly PHQ-9 and GAD-7 pair. A rule that recurs
 *     within the week rolls on, because its next occurrence is the next
 *     reminder anyway and is fixed by the calendar, not by the last reading;
 *     holding a twice-daily Coach course on a missed slot would stall it.
 *   - A reminder with no cadence, or a rule with no occurrence left, has no
 *     next slot and stays due: its last slot is the task.
 *   - An appointment (`ENCOUNTER`) is always one-shot.
 *
 * The one definition. The reminder tick decides with it whether a delivered
 * reminder rolls on; the edit route decides with it whether re-enabling keeps
 * the open slot. The daily digest asks the narrower question underneath it,
 * {@link hasLongCycle}: whether a reminder is infrequent enough to sit on the
 * start page for its whole due day.
 *
 * A course window (`endsOn`) is deliberately not consulted: it ends a
 * Coach-suggested measurement course, which is a short-cycle rhythm and rolls
 * on regardless.
 */
import { calendarDaysUntil } from "@/lib/measurement-reminders/due-day";
import { computeReminderNextDueAt } from "@/lib/measurement-reminders/scheduling";

/** A calendar rule recurring within this many calendar days rolls on after its reminder. */
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
 * elsewhere.
 */
export function holdsOpenAfterReminder(
  reminder: HoldOpenInput,
  timezone: string,
  slot: Date,
): boolean {
  if (reminder.origin === "ENCOUNTER") return false;
  if (reminder.intervalDays !== null) return true;
  return hasLongCycle(reminder, timezone, slot);
}

/**
 * Whether the reminder's cycle is longer than {@link HOLD_OPEN_MIN_CYCLE_DAYS}
 * days, or it has no next slot at all. The daily digest puts such a reminder
 * on the start page from the morning of its due day and keeps it there under
 * the rail cap; a short rhythm (a daily weigh-in at 20:00) waits until its
 * time has come.
 *
 * For a rule the cycle is the calendar-day gap between its next two
 * occurrences from `slot` on, so the answer does not depend on where between
 * two occurrences `slot` sits. With one occurrence left the gap is measured
 * from `slot` to it; with none left the cycle counts as long.
 */
export function hasLongCycle(
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
