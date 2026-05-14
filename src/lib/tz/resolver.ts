/**
 * v1.4.25 W7 — per-user timezone resolver (server-only).
 *
 * HealthLog historically pinned every display surface to the
 * `DISPLAY_TIMEZONE` constant ("Europe/Berlin"). The per-user
 * timezone feature (Option B in `.planning/feature-user-timezone.md`)
 * threads the user's stored zone through every surface that renders
 * a date or buckets by day — exports, charts, AI Coach snapshot,
 * doctor-report PDF, reminders.
 *
 * Two entry points live here:
 *
 *   - `resolveUserTimezone(userId)` reads `User.timezone` and falls
 *     back to the server-wide default. The User column has a NOT
 *     NULL default ("Europe/Berlin") in the schema, so the fallback
 *     only kicks in if a row is somehow missing — defensive, not
 *     load-bearing.
 *
 *   - `resolveServerDefaultTimezone()` reads the singleton
 *     `AppSettings.defaultUserTimezone` and falls back to
 *     "Europe/Berlin" when the operator never set one. This is what
 *     the registration handler hands a new account when the client
 *     doesn't send a browser-detected zone.
 *
 * Both share a 60-second TTL cache keyed by `userId` / `"__server__"`.
 * The hot path (Coach snapshot, export with thousands of rows) would
 * otherwise hammer Prisma. Bust the cache on the rare writes via
 * `invalidateUserTimezone(userId)` (called from the profile PUT and
 * the admin PUT). The cache is module-level intentionally — every
 * Next.js route handler shares the same process, and the per-user
 * write path already invalidates.
 *
 * The pure helpers (`isValidTimezone`, `listSupportedTimezones`,
 * `detectBrowserTimezone`, `formatInUserTz`, `userDayKey`,
 * `DEFAULT_TIMEZONE`) live in `./format` so client components can
 * import them without dragging Prisma + `node:module` into the browser
 * bundle. They are re-exported here so existing server-side callers
 * keep their `@/lib/tz/resolver` import path.
 */
import { prisma } from "@/lib/db";

import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
} from "./format";

export {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  listSupportedTimezones,
  detectBrowserTimezone,
  formatInUserTz,
  userDayKey,
  type FormatInUserTzShape,
} from "./format";

const TTL_MS = 60_000;

interface CacheEntry {
  tz: string;
  expiresAt: number;
}

const userTzCache = new Map<string, CacheEntry>();
let serverTzCache: CacheEntry | null = null;

/**
 * Resolve the server-wide default timezone — the value handed to new
 * accounts on signup when the client did not send a browser-detected
 * zone. Reads the singleton `AppSettings.defaultUserTimezone`. Falls
 * back to "Europe/Berlin" when the column is NULL.
 *
 * Cached for 60 s in process. The admin write path calls
 * `invalidateServerDefaultTimezone()` on change.
 */
export async function resolveServerDefaultTimezone(): Promise<string> {
  const now = Date.now();
  if (serverTzCache && serverTzCache.expiresAt > now) {
    return serverTzCache.tz;
  }
  let tz = DEFAULT_TIMEZONE;
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { defaultUserTimezone: true },
    });
    if (
      settings?.defaultUserTimezone &&
      isValidTimezone(settings.defaultUserTimezone)
    ) {
      tz = settings.defaultUserTimezone;
    }
  } catch {
    // app_settings may not exist on a brand-new DB (first-user
    // bootstrap before any settings write). Fall through to the
    // hard-coded default — every existing instance has the row.
  }
  serverTzCache = { tz, expiresAt: now + TTL_MS };
  return tz;
}

/**
 * Resolve the per-user display timezone. Reads `User.timezone`. Falls
 * back to the server default and then to "Europe/Berlin". Cached for
 * 60 s in process. The profile PUT calls `invalidateUserTimezone()`
 * on change.
 *
 * Returns the server default for unknown userIds — the caller is
 * expected to gate on auth upstream, so an unknown id here is a
 * server-side oddity (test harness, unauthenticated background job)
 * and the server default is the safest interpretation.
 */
export async function resolveUserTimezone(userId: string): Promise<string> {
  if (!userId) return resolveServerDefaultTimezone();
  const now = Date.now();
  const cached = userTzCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.tz;
  }
  let tz: string | null = null;
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    if (row?.timezone && isValidTimezone(row.timezone)) {
      tz = row.timezone;
    }
  } catch {
    tz = null;
  }
  const resolved = tz ?? (await resolveServerDefaultTimezone());
  userTzCache.set(userId, { tz: resolved, expiresAt: now + TTL_MS });
  return resolved;
}

/**
 * Drop the cached value for `userId`. Call from any write path that
 * mutates `User.timezone` so the next read picks up the new zone
 * within one event loop tick rather than waiting for the 60-s TTL.
 */
export function invalidateUserTimezone(userId: string): void {
  userTzCache.delete(userId);
}

/** Drop the cached server-default zone. Call from the admin PUT. */
export function invalidateServerDefaultTimezone(): void {
  serverTzCache = null;
}
