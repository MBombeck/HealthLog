/**
 * The per-user display preferences that are NOT the timezone: the hour cycle
 * and the date order.
 *
 * `resolveUserTimezone()` already answers "which calendar does this user read
 * in". These two answer "how is a clock and a date spelled for them", and
 * every server surface that renders a date on a user's behalf needs all
 * three. They lived as an inline `prisma.user.findUnique` in the share-link
 * download path and nowhere else, which is part of why the clinician page
 * rendered the owner's dates in the display default while the PDF beside it
 * rendered them in the owner's hour cycle (issue #922).
 *
 * Deliberately NOT cached: unlike the timezone (read on nearly every request
 * and invalidated by hand on profile write), these are read on the handful of
 * server-rendered document surfaces, so a cache would add an invalidation
 * obligation to every write path in exchange for nothing measurable.
 */
import { prisma } from "@/lib/db";
import type {
  DateFormatPreference,
  TimeFormatPreference,
} from "@/lib/format-locale";

export interface UserFormatPreferences {
  timeFormat: TimeFormatPreference;
  dateFormat: DateFormatPreference;
}

/**
 * Read `users.time_format` + `users.date_format`. An unknown id, a null
 * column, or an unreachable database all resolve to AUTO — the same
 * "follow the locale" answer the columns' own default carries, so a
 * document still renders rather than failing on a preference lookup.
 */
export async function resolveUserFormatPreferences(
  userId: string,
): Promise<UserFormatPreferences> {
  if (!userId) return { timeFormat: "AUTO", dateFormat: "AUTO" };
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { timeFormat: true, dateFormat: true },
    });
    return {
      timeFormat: row?.timeFormat ?? "AUTO",
      dateFormat: row?.dateFormat ?? "AUTO",
    };
  } catch {
    return { timeFormat: "AUTO", dateFormat: "AUTO" };
  }
}
