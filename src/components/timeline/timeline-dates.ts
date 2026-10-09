/**
 * Calendar arithmetic for the timeline (v1.42, #613).
 *
 * Every date the timeline handles is a stated calendar date (`YYYY-MM-DD`):
 * the server cut it in the record's zone already, so nothing here may read it
 * through the browser's zone again. Dates become whole day numbers since the
 * epoch (UTC midnight), which keeps the x-scale linear across daylight-saving
 * changes and makes "one day to the right" exactly `+1`.
 *
 * Formatting reads the same UTC instant back with `timeZone: "UTC"`, so a
 * date never moves by a day for a reader east or west of Greenwich.
 */
import type { TimelineBucket } from "@/lib/day/contract";

const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 for a `YYYY-MM-DD` key. */
export function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** The `YYYY-MM-DD` key of a day number. */
export function dayKey(day: number): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: a calendar key held as UTC midnight, never an instant
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** `YYYY-MM` of a date key. */
export function monthOf(key: string): string {
  return key.slice(0, 7);
}

/** First day of the month a key falls in. */
export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

/** Last day of the month a key falls in. */
export function endOfMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return dayKey(Math.round(Date.UTC(y, m, 0) / MS_PER_DAY));
}

/**
 * The key `months` calendar months away, clamped to the target month's
 * length (31 January plus one month is 28 or 29 February).
 */
export function addMonths(key: string, months: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: a calendar key held as UTC midnight, never an instant
  return target.toISOString().slice(0, 10);
}

/* ─── Series buckets ──────────────────────────────────────────────────────── */

/** The first day of the bucket `key` falls in. Weeks start on Monday. */
export function bucketStart(key: string, bucket: TimelineBucket): string {
  if (bucket === "month") return startOfMonth(key);
  if (bucket === "quarter") {
    const month = Number(key.slice(5, 7));
    const first = month - ((month - 1) % 3);
    return `${key.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
  }
  const day = dayNumber(key);
  // 1970-01-01 was a Thursday: day 4 is the first Monday.
  return dayKey(day - ((((day - 4) % 7) + 7) % 7));
}

/** The first day after the bucket that starts on `start`. */
export function bucketAfter(start: string, bucket: TimelineBucket): string {
  if (bucket === "month") return addMonths(start, 1);
  if (bucket === "quarter") return addMonths(start, 3);
  return dayKey(dayNumber(start) + 7);
}

/**
 * A running number for the bucket that starts on `start`: neighbouring
 * buckets differ by one, so a difference counts the buckets between.
 */
export function bucketIndex(start: string, bucket: TimelineBucket): number {
  if (bucket === "week") return Math.floor((dayNumber(start) - 4) / 7);
  const months = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1;
  return bucket === "quarter" ? Math.floor(months / 3) : months;
}

/** Every `YYYY-MM-01` from the month of `from` through the month of `to`. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = startOfMonth(from);
  const last = startOfMonth(to);
  while (cursor <= last) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/** Today's calendar date in an IANA zone, as `YYYY-MM-DD`. */
export function todayKeyIn(timeZone: string | undefined, now = new Date()) {
  try {
    // `en-CA` formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unknown zone name: the browser's own calendar day is the honest
    // fallback, not UTC's.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}

function utcDate(key: string): Date {
  return new Date(dayNumber(key) * MS_PER_DAY);
}

function format(
  key: string,
  intlLocale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(intlLocale, {
    ...options,
    timeZone: "UTC",
  }).format(utcDate(key));
}

/** "Januar 2026". */
export function formatMonthYear(key: string, intlLocale: string): string {
  return format(key, intlLocale, { month: "long", year: "numeric" });
}

/** "Jan. 2026". */
export function formatMonthYearShort(key: string, intlLocale: string): string {
  return format(key, intlLocale, { month: "short", year: "numeric" });
}

/** "3. Jan.". */
export function formatDayMonth(key: string, intlLocale: string): string {
  return format(key, intlLocale, { day: "numeric", month: "short" });
}

/** "3. Jan. 2026". */
export function formatDayMonthYear(key: string, intlLocale: string): string {
  return format(key, intlLocale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "3. Januar 2026". */
export function formatDayMonthYearLong(
  key: string,
  intlLocale: string,
): string {
  return format(key, intlLocale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** "Jan". Axis labels. */
export function formatMonthShort(key: string, intlLocale: string): string {
  return format(key, intlLocale, { month: "short" });
}

/** "Januar". */
export function formatMonthLong(key: string, intlLocale: string): string {
  return format(key, intlLocale, { month: "long" });
}

/**
 * A date at the precision it was recorded with: "3. Jan. 2026", "Sept.
 * 2023" or "2019". Life events and stand-in dates use this, so a month the
 * person gave is never shown as its first day.
 */
export function formatAtPrecision(
  key: string,
  precision: "DAY" | "MONTH" | "YEAR",
  intlLocale: string,
): string {
  if (precision === "YEAR") return key.slice(0, 4);
  if (precision === "MONTH") return formatMonthYearShort(key, intlLocale);
  return formatDayMonthYear(key, intlLocale);
}

/**
 * How a series bucket reads: "Januar 2026" for a month, otherwise its first
 * and last day for the caller's "{from} to {to}" ("Jan to März 2026",
 * "5. Jan. to 11. Jan. 2026").
 */
export function formatBucket(
  start: string,
  bucket: TimelineBucket,
  intlLocale: string,
): string | { from: string; to: string } {
  if (bucket === "month") return formatMonthYear(start, intlLocale);
  const last = dayKey(dayNumber(bucketAfter(start, bucket)) - 1);
  if (bucket === "quarter") {
    return {
      from: formatMonthShort(start, intlLocale),
      to: formatMonthYearShort(last, intlLocale),
    };
  }
  return {
    from: formatDayMonth(start, intlLocale),
    to: formatDayMonthYear(last, intlLocale),
  };
}
