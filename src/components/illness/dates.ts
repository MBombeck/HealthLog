/**
 * Date serialization and parsing helpers for illness episodes.
 *
 * Date-only fields (`YYYY-MM-DD`) from `<DateField>` are serialized to ISO 8601
 * instants for the `/api/illness/episodes` wire contract.
 */
import { userDayKey } from "@/lib/tz/format";
import { zonedWallClockToUtc } from "@/lib/tz/wall-clock";

/**
 * Serialize a date-only input (`YYYY-MM-DD`) to an ISO 8601 instant.
 * Anchors to local noon in the user's timezone, or now if noon is still in the future.
 */
export function serializeEpisodeDate(
  date: string,
  timeZone: string,
  now: Date = new Date(),
): string {
  const [year, month, day] = date.split("-").map(Number);
  const localNoon = zonedWallClockToUtc(
    { year, month, day, hour: 12, minute: 0, second: 0 },
    timeZone,
  );
  const ms = Math.min(localNoon.getTime(), now.getTime());
  return new Date(ms).toISOString();
}

/**
 * Resolve an episode instant from a calendar date input, preserving the exact
 * stored timestamp when the calendar date is unchanged in the active display timezone.
 */
export function resolveEpisodeInstant({
  date,
  storedInstant,
  now,
  timeZone,
}: {
  date: string;
  storedInstant?: string | null;
  now: Date;
  timeZone: string;
}): string {
  if (
    storedInstant != null &&
    date === userDayKey(new Date(storedInstant), timeZone)
  ) {
    return storedInstant;
  }
  return serializeEpisodeDate(date, timeZone, now);
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
  now,
  timeZone,
}: {
  onset: string;
  resolved: string;
  storedOnset?: string | null;
  storedResolved?: string | null;
  now: Date;
  timeZone: string;
}): { onsetAt: string; resolvedAt: string | null } {
  const onsetAt = resolveEpisodeInstant({
    date: onset,
    storedInstant: storedOnset,
    now,
    timeZone,
  });
  let resolvedAt =
    resolved === ""
      ? null
      : resolveEpisodeInstant({
          date: resolved,
          storedInstant: storedResolved,
          now,
          timeZone,
        });
  if (
    resolvedAt !== null &&
    onset === resolved &&
    new Date(resolvedAt).getTime() < new Date(onsetAt).getTime()
  ) {
    resolvedAt = onsetAt;
  }
  return { onsetAt, resolvedAt };
}
