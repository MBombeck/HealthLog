/**
 * Robust timezone utilities using Intl.DateTimeFormat.
 * Replaces the fragile `new Date(date.toLocaleString("en-US", { timeZone }))` pattern
 * which can produce incorrect results due to locale-dependent date string parsing.
 */

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
}

/**
 * Extract date/time parts for a given instant in a specific timezone.
 * Uses Intl.DateTimeFormat.formatToParts for reliable, locale-independent parsing.
 */
export function getLocalDateParts(date: Date, tz: string): LocalDateParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  // Intl hour12:false can return "24" for midnight in some engines
  const rawHour = parseInt(get("hour"), 10);

  const weekdayStr = get("weekday");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    dayOfWeek: weekdayMap[weekdayStr] ?? 0,
  };
}

/**
 * Get the start (midnight) and end (23:59:59.999) of "today" in the user's timezone,
 * returned as UTC Date objects suitable for database queries.
 */
export function getUserTodayBounds(
  now: Date,
  tz: string,
): { start: Date; end: Date } {
  const parts = getLocalDateParts(now, tz);

  // Build a UTC date that represents the user's local midnight
  // by computing the offset between the real UTC time and the local representation
  const localMidnightAsUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0),
  );

  // Compute offset: how far ahead (positive) or behind (negative) the tz is from UTC
  // localMidnightAsUtc represents "midnight in tz as if it were UTC"
  // We need to find what UTC instant corresponds to midnight in the given tz
  const localNowAsUtc = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  const offsetMs =
    Math.round((localNowAsUtc.getTime() - now.getTime()) / 60000) * 60000;

  const start = new Date(localMidnightAsUtc.getTime() - offsetMs);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);

  return { start, end };
}

/**
 * Get the day of the week (0=Sun..6=Sat) for a given instant in a specific timezone.
 */
export function getDayOfWeekInTz(now: Date, tz: string): number {
  return getLocalDateParts(now, tz).dayOfWeek;
}

/**
 * Compute the UTC instant of local `hh:mm` on the local calendar day
 * implied by `now` in `tz`. DST-safe — `todayStart.getTime() + h * 3.6e6`
 * drifts by an hour on spring-forward / fall-back days because raw UTC
 * arithmetic ignores the DST jump between local midnight and local
 * `hh:mm`. This helper re-derives the offset at the target local time
 * so the returned instant always represents local `hh:mm`.
 */
export function localHmAsUtc(
  now: Date,
  tz: string,
  hour: number,
  minute: number,
): Date {
  const parts = getLocalDateParts(now, tz);
  const localAtTargetAsUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0),
  );
  const localNowAsUtc = new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
  const offsetMs =
    Math.round((localNowAsUtc.getTime() - now.getTime()) / 60000) * 60000;
  return new Date(localAtTargetAsUtc.getTime() - offsetMs);
}
