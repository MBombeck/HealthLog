/**
 * Date-only values: a calendar date (`YYYY-MM-DD`) with no time of day — a
 * report's stated date, a document's filing date, a backup's label for a
 * `@db.Date` column.
 *
 * Such a value is stored in a timestamp column as noon UTC. Noon keeps the
 * date on the same calendar day whether it is read back as a UTC label
 * ({@link dateOnlyKey}) or formatted in any zone from UTC-11 to UTC+11. The
 * older anchor, UTC midnight, sits on the previous evening everywhere west
 * of UTC, which is how a stated report date came to show a day early.
 *
 * Rows written at UTC midnight before the switch still read back to the same
 * key through {@link dateOnlyKey}, so the two anchors coexist without a
 * migration.
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/u;

/** True for a strict `YYYY-MM-DD` string. */
export function isDateOnlyKey(value: string): boolean {
  return DATE_ONLY_RE.test(value);
}

/**
 * True for a `YYYY-MM-DD` string that names a real calendar date.
 * `2026-02-30` passes the shape check but overflows to 2 March when parsed,
 * so a reader would return a different day than the one asked for.
 */
export function isCalendarDateKey(value: string): boolean {
  if (!DATE_ONLY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

/**
 * The calendar date a free-form date string states, or `null`. An ISO string
 * (`2026-06-10`, `2026-06-10T08:00:00+09:00`) states the date it starts with.
 * Anything else (`June 10, 2026`) is parsed the way `Date` parses it, as local
 * time in the process zone, so the date is read back in that same zone;
 * reading it as UTC put it on the previous day for a process east of UTC.
 */
export function statedDateKey(raw: string): string | null {
  const trimmed = raw.trim();
  const isoPrefix = /^(\d{4}-\d{2}-\d{2})(?:$|T|\s)/u.exec(trimmed);
  if (isoPrefix) {
    return isCalendarDateKey(isoPrefix[1]) ? isoPrefix[1] : null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(parsed.getFullYear()).padStart(4, "0")}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

/** The instant a date-only value is stored as: 12:00 UTC on that date. */
export function dateOnlyAtNoonUtc(key: string): Date {
  return new Date(`${key}T12:00:00.000Z`);
}

/**
 * True when a stored instant is the noon-UTC anchor of a date-only value.
 *
 * For a column that holds both kinds (a lab reading typed with its time of
 * day, or imported from a report that states only the date), this is how a
 * reader tells them apart. A reading typed at exactly 12:00:00.000 UTC reads
 * as its UTC calendar date, which is its local date everywhere from UTC-11
 * to UTC+11.
 */
export function isNoonUtcAnchor(value: Date): boolean {
  return (
    value.getUTCHours() === 12 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

/**
 * The calendar date of a stored date-only value (or of a `@db.Date` column,
 * which Prisma hands back as UTC midnight). Only for values that ARE dates:
 * the day an instant fell on for a person is `userDayKey(instant, tz)`.
 */
export function dateOnlyKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Calendar date `key` as UTC midnight. A LABEL, never the instant the day
 * began for anyone: it is how a `@db.Date` column holds a date (Prisma reads
 * and writes those as UTC midnight), how the day rollups key `bucketStart`,
 * and how a day-keyed series places a point on a time axis. Use it to compare
 * such a column with a day (`endsOn >= dayKeyAsUtcMidnight(todayKey)` keeps a
 * course through its last day, where comparing with the instant `now` dropped
 * it) or to build such a label. The first instant of a person's day is
 * `startOfLocalDayKey(key, tz)`.
 */
export function dayKeyAsUtcMidnight(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * The window over a date-only column that holds the calendar days `fromKey`
 * to `toKey`, both included: UTC midnight to the next UTC midnight, so both
 * anchors (midnight and noon UTC) fall on their own date. A date-only value
 * read through a person's local-day window sat on the evening before west of
 * UTC.
 */
export function dateOnlyWindow(
  fromKey: string,
  toKey: string = fromKey,
): { gte: Date; lt: Date } {
  const lt = dayKeyAsUtcMidnight(toKey);
  lt.setUTCDate(lt.getUTCDate() + 1);
  return { gte: dayKeyAsUtcMidnight(fromKey), lt };
}
