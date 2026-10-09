import { isCalendarDateKey } from "@/lib/tz/date-only";

/**
 * The `YYYY-MM-DDTHH:mm` a capture form starts with, in the browser's local
 * time, the shape every quick-entry form keeps its date-time field in.
 *
 * Without a day it is now. Opened from a past day ("Capture for this day"),
 * it is that day at the current time of day, so the person only adjusts the
 * clock if it matters. A day that is not a calendar date falls back to now.
 */
export function localDateTimeValue(
  dateKey?: string | null,
  now: Date = new Date(),
): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  if (!dateKey || !isCalendarDateKey(dateKey)) return local;
  return `${dateKey}${local.slice(10)}`;
}
