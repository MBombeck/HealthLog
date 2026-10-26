/**
 * The day bound of a JSON-imported mood entry without a logged instant, on
 * its own so the import schema can bound such a row without reaching the
 * writer and the database client behind it.
 */
import { moodDateKey } from "@/lib/mood/date-key";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

/**
 * The start of a `YYYY-MM-DD` day in the default zone, or null when the
 * string does not name a real day. The route's schema uses it to bound a row
 * without a logged instant.
 */
export function fallbackMoodDateStart(date: string): Date | null {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return null;
  const instant = zonedWallClockToUtc(
    { year, month, day, hour: 0, minute: 0 },
    DEFAULT_TIMEZONE,
  );
  return moodDateKey(instant, DEFAULT_TIMEZONE) === date ? instant : null;
}
