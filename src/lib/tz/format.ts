/**
 * v1.4.25 W7 — pure timezone helpers (no Prisma, no Node-only modules).
 *
 * Split out from `./resolver` in v1.4.25 Fix-G so client components can
 * import constants and formatters without dragging `node:module` (via
 * Prisma) into the browser bundle. The Prisma-backed resolvers
 * (`resolveUserTimezone`, `resolveServerDefaultTimezone`) stay in
 * `./resolver`; the resolver re-exports every helper from this file so
 * existing server-side callers keep their `@/lib/tz/resolver` import
 * path. New code should prefer `@/lib/tz/format` for the pure helpers
 * and `@/lib/tz/resolver` only when it needs the cached User/Settings
 * lookup.
 */

export const DEFAULT_TIMEZONE = "Europe/Berlin";

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

/**
 * v1.4.38 W-A — cross-tz fast-path runtime guard.
 *
 * Returns `true` when the supplied IANA zone is within ±3 hours of UTC
 * at the supplied instant. Used by the analytics fast-paths
 * (`bp-in-target-fast-path`, `correlations-fast-path`) to gate the
 * rollup read-swap: those helpers key rollup rows on UTC-midnight
 * `bucketStart` and pair them with per-event streams keyed in the
 * user's local timezone. For Berlin (+1/+2) the day-key on the rollup
 * and the day-key on the per-event row line up; for Honolulu (-10)
 * they slip by a calendar day. Three hours is a conservative pin —
 * the worst-case slip inside the window is the wall-clock hour-of-day
 * the user happens to log at, and three hours covers every European
 * zone plus the western edge of Mid-Atlantic / eastern edge of the
 * Americas.
 *
 * Falls back to "near-UTC" (i.e. returns `true`) when the zone string
 * is invalid — the resolver layer is already defensive about junk
 * values, and a `true` here means the caller takes the rollup
 * fast-path which is the safer default for the canonical Berlin
 * tenant.
 *
 * The `now` argument lets callers honour DST transitions; the offset
 * of `Europe/Berlin` is +1 in January and +2 in July. Defaults to
 * "now" so most callers can `isNearUtc(userTz)`.
 */
export function isNearUtc(tz: string, now: Date = new Date()): boolean {
  const safeTz = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  const offsetMinutes = tzOffsetMinutes(now, safeTz);
  return Math.abs(offsetMinutes) <= 3 * 60;
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
 *     stable day-bucket key for per-user aggregation.
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
 * Day-bucket key in the user's timezone. Used as a stable Map key for
 * daily aggregation so a 23:30-local reading lands on today's bucket
 * regardless of UTC offset. Every display surface in v1.4.40 anchors
 * here — the legacy Berlin-only `berlinDayKey()` was retired in that
 * release.
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
