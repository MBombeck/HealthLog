/**
 * Date serialization and parsing helpers for illness episodes.
 *
 * Date-only fields (`YYYY-MM-DD`) from `<DateField>` are serialized to ISO 8601
 * instants for the `/api/illness/episodes` wire contract.
 */
import { isCalendarDateKey } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

/**
 * Format a stored ISO instant to a `YYYY-MM-DD` calendar date string in the
 * target timezone (defaults to the browser's local calendar if omitted).
 *
 * For backwards compatibility with legacy records, pre-standardized date prefixes,
 * or mock/draft inputs that cannot be parsed by `Date`, falls back to extracting
 * the leading 10 characters (`iso.slice(0, 10)`) rather than throwing or returning
 * an invalid date representation.
 */
export function toLocalDateKey(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  // Compatibility fallback: preserve existing prefix slice for unparseable legacy
  // timestamps, draft representations, or malformed test inputs rather than failing.
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  if (timeZone) {
    return userDayKey(d, timeZone);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Serialize a date-only input (`YYYY-MM-DD`) to an ISO 8601 instant.
 *
 * Automatically trims surrounding whitespace from the date input.
 *
 * For historical dates (`date < today`), the instant is anchored at local noon
 * (`12:00:00`) in the user's timezone, preserving established behavior and
 * ensuring the UTC instant stays on the intended calendar day in standard
 * timezones without drifting.
 *
 * When the selected date is `today`:
 *   - If the current time is on or after local noon, local noon is already in
 *     the past, so it passes bounded-entry validation and preserves the noon anchor.
 *   - If the UI is used before local noon, local noon is in the future and would
 *     be rejected by the backend's strict future-time check (5-min skew limit).
 *     In this case, the instant is capped to `now`, which is guaranteed to be in
 *     the past/present and falls on today's calendar date in the user's timezone.
 */
export function serializeEpisodeDate(
  date: string,
  today: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  // Runtime non-string guards: defend at the JS boundary before calling string methods.
  if (typeof date !== "string") {
    throw new RangeError(
      `Invalid episode calendar date: expected a valid YYYY-MM-DD date, received ${JSON.stringify(date)}`,
    );
  }
  if (typeof today !== "string") {
    throw new RangeError(
      `Invalid episode calendar date: expected a valid YYYY-MM-DD today date, received ${JSON.stringify(today)}`,
    );
  }
  const trimmedDate = date.trim();
  const trimmedToday = today.trim();
  if (!isCalendarDateKey(trimmedDate)) {
    throw new RangeError(
      `Invalid episode calendar date: expected a valid YYYY-MM-DD date, received ${JSON.stringify(date)}`,
    );
  }
  const [year, month, day] = trimmedDate.split("-").map(Number);
  const localNoon = zonedWallClockToUtc(
    { year, month, day, hour: 12, minute: 0, second: 0 },
    timeZone,
  );
  const isToday = trimmedDate === trimmedToday;
  const isBeforeNoonToday = isToday && localNoon.getTime() > now.getTime();
  const instant = isBeforeNoonToday ? now : localNoon;
  return instant.toISOString();
}

/**
 * Resolve an episode instant from a calendar date input, preserving the exact
 * stored timestamp when the calendar date is unchanged in the active display timezone.
 *
 * Automatically trims surrounding whitespace from `date` internally before
 * calendar-day comparison and serialization.
 */
export function resolveEpisodeInstant({
  date,
  storedInstant,
  today,
  now,
  timeZone,
}: {
  date: string;
  storedInstant?: string | null;
  today: string;
  now: Date;
  timeZone?: string;
}): string {
  if (typeof date !== "string") {
    throw new RangeError(
      `Invalid episode calendar date: expected a valid YYYY-MM-DD date, received ${JSON.stringify(date)}`,
    );
  }
  const trimmedDate = date.trim();
  if (
    storedInstant != null &&
    isCalendarDateKey(trimmedDate) &&
    trimmedDate === toLocalDateKey(storedInstant, timeZone)
  ) {
    return storedInstant;
  }
  return serializeEpisodeDate(trimmedDate, today, now, timeZone);
}

/**
 * Resolve both instants of an episode save from its two calendar-date fields.
 *
 * Each field keeps its stored instant when the selected calendar date is
 * unchanged (see {@link resolveEpisodeInstant}); the rest are serialized. An
 * end date equal to the onset is clamped up to the onset's instant, because a
 * preserved end can otherwise sit before a freshly serialized same-day onset
 * (e.g. onset changed to today before local noon).
 */
export function resolveEpisodeWindow({
  onset,
  resolved,
  storedOnset,
  storedResolved,
  today,
  now,
  timeZone,
}: {
  onset: string;
  resolved: string;
  storedOnset?: string | null;
  storedResolved?: string | null;
  today: string;
  now: Date;
  timeZone?: string;
}): { onsetAt: string; resolvedAt: string | null } {
  const trimmedOnset = onset.trim();
  const trimmedResolved = resolved.trim();
  const onsetAt = resolveEpisodeInstant({
    date: trimmedOnset,
    storedInstant: storedOnset,
    today,
    now,
    timeZone,
  });
  let resolvedAt =
    trimmedResolved === ""
      ? null
      : resolveEpisodeInstant({
          date: trimmedResolved,
          storedInstant: storedResolved,
          today,
          now,
          timeZone,
        });
  if (
    resolvedAt !== null &&
    trimmedOnset === trimmedResolved &&
    new Date(resolvedAt).getTime() < new Date(onsetAt).getTime()
  ) {
    resolvedAt = onsetAt;
  }
  return { onsetAt, resolvedAt };
}
