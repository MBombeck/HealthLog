/**
 * The calendar day a lab reading belongs to.
 *
 * Two kinds of reading share `LabResult.takenAt`. A scanned or document
 * reading states a date only, stored at noon UTC (rows from before the noon
 * anchor sit at UTC midnight); its day is that date. A reading entered by
 * hand carries the real instant of the draw; its day is the user's day of
 * that instant. Cutting both on the UTC day, as the duplicate checks did,
 * put a morning draw east of UTC on the previous day, so a scan of the same
 * report wrote the reading a second time.
 */
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

const DAY_MS = 86_400_000;
const NOON_MS = 43_200_000;

/**
 * True when a stored `takenAt` is a date-only anchor (UTC noon, or UTC
 * midnight for the older rows) rather than the instant of a draw. The one
 * test every surface uses to decide whether a reading is dated by its
 * calendar date or by the reader's zone.
 */
export function isLabDateOnly(takenAt: Date | string | number): boolean {
  const ms = new Date(takenAt).getTime();
  const msOfDay = ((ms % DAY_MS) + DAY_MS) % DAY_MS;
  return msOfDay === 0 || msOfDay === NOON_MS;
}

export function labReadingDay(
  takenAt: Date | string | number,
  tz: string,
): string {
  const instant = new Date(takenAt);
  if (isLabDateOnly(instant)) return dateOnlyKey(instant);
  return userDayKey(instant, tz);
}

/**
 * A `takenAt` range wide enough to hold every reading whose
 * {@link labReadingDay} is `day`, in any zone from UTC-12 to UTC+14. It
 * over-selects by design; filter the rows with `labReadingDay` afterwards.
 */
export function labReadingDaySearchRange(day: string): {
  gte: Date;
  lt: Date;
} {
  return {
    gte: dayKeyAsUtcMidnight(shiftDateKey(day, -1)),
    lt: dayKeyAsUtcMidnight(shiftDateKey(day, 2)),
  };
}
