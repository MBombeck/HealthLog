/**
 * v1.4.25 W7 — per-user timezone resolver.
 *
 * HealthLog historically pinned every display surface to the
 * `DISPLAY_TIMEZONE` constant ("Europe/Berlin"). The per-user
 * timezone feature (Option B in `.planning/feature-user-timezone.md`)
 * threads the user's stored zone through every surface that renders
 * a date or buckets by day — exports, charts, AI Coach snapshot,
 * doctor-report PDF, reminders.
 *
 * The resolver is intentionally narrow:
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
 *   - `detectBrowserTimezone()` is the client-only helper that
 *     returns `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 *     Used by the signup form and the profile picker's "use my
 *     browser zone" button.
 *
 *   - `formatInUserTz(date, tz, format?)` is the server-side
 *     formatter. Three named formats keep the call sites tight:
 *     "iso-with-offset" for exports, "wall-clock" for chart labels,
 *     "datetime" for PDFs / notifications.
 *
 * Both resolver entry points share a 60-second TTL cache keyed by
 * `userId` / `"__server__"`. The hot path (Coach snapshot, export
 * with thousands of rows) would otherwise hammer Prisma. Bust the
 * cache on the rare writes via `invalidateUserTimezone(userId)`
 * (called from the profile PUT and the admin PUT). The cache is
 * module-level intentionally — every Next.js route handler shares
 * the same process, and the per-user write path already invalidates.
 */
import { prisma } from "@/lib/db";

export const DEFAULT_TIMEZONE = "Europe/Berlin";

const TTL_MS = 60_000;

interface CacheEntry {
  tz: string;
  expiresAt: number;
}

const userTzCache = new Map<string, CacheEntry>();
let serverTzCache: CacheEntry | null = null;

/**
 * Validate a timezone string by asking `Intl.DateTimeFormat` to use it.
 * Returns `true` if the runtime accepts the zone, `false` otherwise.
 * Cheap (microseconds) — call freely at write paths.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string" || tz.length === 0 || tz.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The list of every IANA zone the current Node runtime accepts.
 * Returns an empty array on engines older than Node 22 / V8 12.5
 * where `Intl.supportedValuesOf` is unavailable — callers should
 * fall back to free-text input plus `isValidTimezone()` validation.
 */
export function listSupportedTimezones(): string[] {
  const supportedValuesOf = (
    Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    }
  ).supportedValuesOf;
  if (typeof supportedValuesOf !== "function") return [];
  try {
    return supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

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

/**
 * Client-only helper. Reads the browser's resolved timezone via the
 * `Intl` API. Returns the string the browser hands us — no
 * validation, no fallback — because the consumer (signup form,
 * profile picker hint) is going to round-trip the value through the
 * server's `isValidTimezone()` check anyway. Safe on every modern
 * browser back to Edge 18 / Safari 11 / Chrome 24.
 */
export function detectBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export type FormatInUserTzShape =
  | "iso-with-offset"
  | "wall-clock"
  | "datetime"
  | "date";

/**
 * Format an instant in the user's timezone.
 *
 *   - "iso-with-offset" — `2026-05-11T11:05:00+02:00` (no
 *     milliseconds, sortable, machine-parseable). Issue #167 fix:
 *     replaces `.toISOString()` in CSV/JSON exports.
 *
 *   - "wall-clock" — `11:05` (24h, no seconds). Used by chart axis
 *     labels and notification preambles.
 *
 *   - "datetime" — `2026-05-11 11:05` (24h, locale-independent for
 *     audit/PDF tables). Equivalent to the `formatters.dateTime`
 *     helper but with a per-call timezone instead of the global
 *     `DISPLAY_TIMEZONE`.
 *
 *   - "date" — `2026-05-11` (ISO date in the user's zone). Used as a
 *     day-bucket key parallel to the legacy `berlinDayKey()`.
 */
export function formatInUserTz(
  date: Date,
  tz: string,
  format: FormatInUserTzShape = "iso-with-offset",
): string {
  const safeTz = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  switch (format) {
    case "iso-with-offset":
      return formatIsoWithOffset(date, safeTz);
    case "wall-clock":
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: safeTz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date);
    case "datetime": {
      const parts = wallClockParts(date, safeTz);
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    }
    case "date": {
      const parts = wallClockParts(date, safeTz);
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  }
}

/**
 * Day-bucket key in the user's timezone. Mirrors `berlinDayKey()` but
 * parameterised. Used as a stable Map key for daily aggregation so a
 * 23:30-local reading lands on today's bucket regardless of UTC
 * offset. The legacy `berlinDayKey()` stays for surfaces that are
 * not yet user-scoped (admin tables, audit log viewer).
 */
export function userDayKey(date: Date, tz: string): string {
  return formatInUserTz(date, tz, "date");
}

interface WallClockParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function wallClockParts(date: Date, tz: string): WallClockParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  // Some engines render midnight as "24:00".
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Format a Date as `YYYY-MM-DDTHH:MM:SS±HH:MM` for the requested
 * timezone. Sortable, lossless w.r.t. the UTC instant, and reads
 * correctly in Excel / LibreOffice (the CSV-export bug in issue #167
 * was triggered by `Z` getting stripped by Excel before display, so
 * UTC-with-offset values are misread as local). Seconds are
 * preserved (not milliseconds — the export only carries timestamps
 * at second resolution anyway).
 */
function formatIsoWithOffset(date: Date, tz: string): string {
  const parts = wallClockParts(date, tz);
  const offsetMinutes = tzOffsetMinutes(date, tz);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offH}:${offM}`;
}

/**
 * Compute the UTC offset of a timezone at a specific instant, in
 * minutes. Positive east of UTC, negative west. Honours DST because
 * `Intl.DateTimeFormat` does — we reconstruct the offset from the
 * difference between the wall-clock parts and the UTC parts.
 */
function tzOffsetMinutes(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  const hour = get("hour") === 24 ? 0 : get("hour");
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}
