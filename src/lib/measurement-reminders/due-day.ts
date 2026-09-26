/**
 * The one place a Vorsorge reminder's next-due instant becomes the words a
 * person reads: "heute" / "morgen" / "in N Tagen" / "überfällig seit N Tagen".
 *
 * It used to live inside the two surfaces that render it — the `/checkups`
 * page and the dashboard summary card — as two hand-copied bodies. The page
 * copy was fixed to compare CALENDAR days; the dashboard copy was not, and
 * kept differencing raw instants. So the same reminder read "morgen" on one
 * screen and "in 2 Tagen" on the other, and a reminder due this morning
 * dropped out of "heute" over the course of the afternoon. One body here, both
 * surfaces importing it, and the two cannot disagree again.
 *
 * Sits beside `scheduling.ts` (which computes the server-authoritative
 * `nextDueAt`) because this is the read side of the same value. Nothing in
 * this file touches the database or the network, so a client component can
 * import it directly.
 *
 * The words are only half of it. The AI features payload states the same
 * distance as a bare number ("due in N days", "overdue by N days") for the
 * briefing to narrate, and it counted hours the way the dashboard card used
 * to. So the counting itself is {@link calendarDaysUntil} and both the words
 * and the number come off it — the screens and the prose the model writes
 * about them cannot say different things about the same reminder.
 */
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/tz/format";
import { localDayIndex, wallClockInTz } from "@/lib/tz/wall-clock";

/** A fully-qualified i18n key plus the day count it interpolates. */
export interface RelativeDue {
  key: string;
  days: number;
}

/**
 * How many CALENDAR days forward `target` sits from `now`, both read on the
 * wall clock of `timeZone`. Today is 0, tomorrow is 1, yesterday is -1.
 *
 * Not an hour count divided by 24. A checkup due at 09:00 is still due today
 * at 20:00; one due tomorrow at 01:00 is tomorrow's whether it is read at
 * 23:00 tonight or at 06:00 this morning. Dividing the gap by 24 h answers a
 * different question and gets both of those wrong, and it also admits the
 * 23 h / 25 h length of a clock-change day. This differences two integer day
 * indices instead, so the answer is exact by construction rather than by
 * rounding.
 *
 * `timeZone` is the person's PROFILE zone — the same clock the date printed
 * beside the phrase is rendered in. It is required on purpose: it used to be
 * implicit, so the day floor silently took the DEVICE clock while the date
 * next to it took the profile clock, and on a laptop set elsewhere the card
 * printed a date and a phrase that contradicted each other. A zone that
 * cannot be read falls back exactly as `relativeCalendarDate` and `fmt.date`
 * do (issue #490) — to Berlin, never to the host clock, because landing on
 * the host is what let the two halves drift apart in the first place.
 */
export function calendarDaysUntil(
  target: Date,
  now: Date,
  timeZone: string,
): number {
  const zone = isValidTimezone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  return (
    localDayIndex(wallClockInTz(target, zone)) -
    localDayIndex(wallClockInTz(now, zone))
  );
}

/**
 * v1.32.36 — returns a FULLY-QUALIFIED i18n key, not a bare tail. A call site
 * that interpolates the tail onto the namespace root anchors the
 * reverse-coverage guard at that bare namespace, which marks every key under
 * it reachable and turns the guard into a no-op for the whole namespace. The
 * guard now refuses that shape outright, so the key is built whole here.
 *
 * Pass what the neighbouring date label renders in — `useDisplayTimezone()`
 * on the client. The zone argument carries straight through to
 * {@link calendarDaysUntil}, which is where the day counting happens and
 * where the reasoning for both the requirement and the fallback lives.
 */
export function relativeDueKey(
  nextDueAt: string | null,
  now: number,
  timeZone: string,
): RelativeDue {
  if (!nextDueAt) return { key: "measurementReminders.nextDue.none", days: 0 };
  const due = new Date(nextDueAt);
  if (Number.isNaN(due.getTime()))
    return { key: "measurementReminders.nextDue.none", days: 0 };
  const deltaDays = calendarDaysUntil(due, new Date(now), timeZone);
  // Its own phrase rather than the counted one: "overdue by 1 days" is what
  // the counted form reads as, on the one day an open check-up (which since
  // v1.39.2 stays due after its reminder) is most likely to be looked at.
  if (deltaDays === -1)
    return { key: "measurementReminders.overdueSinceYesterday", days: 1 };
  if (deltaDays < 0)
    return {
      key: "measurementReminders.overdueByDays",
      days: Math.abs(deltaDays),
    };
  if (deltaDays === 0)
    return { key: "measurementReminders.nextDue.today", days: 0 };
  if (deltaDays === 1)
    return { key: "measurementReminders.nextDue.tomorrow", days: 1 };
  return { key: "measurementReminders.nextDue.inDays", days: deltaDays };
}

/**
 * Whether a phrase from {@link relativeDueKey} says "overdue". Two keys do —
 * "since yesterday" and the counted one — so a surface that colours an
 * overdue badge asks here rather than comparing against one of them.
 */
export function isOverdueDue(due: RelativeDue): boolean {
  return (
    due.key === "measurementReminders.overdueByDays" ||
    due.key === "measurementReminders.overdueSinceYesterday"
  );
}
