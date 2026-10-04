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

import { getDateTimeFormat } from "./intl-cache";
import { wallClockFromOffset, zoneOffsetMs } from "./zone-offset";

export const DEFAULT_TIMEZONE = "Europe/Berlin";

/**
 * Hoisted option constants so the formatter memo's WeakMap signature
 * lookup hits the same object identity on every call — see
 * `./intl-cache`. `WALL_CLOCK_PARTS_OPTIONS` is shared by
 * `wallClockParts` AND `tzOffsetMinutes`, so both resolve to the SAME
 * memoised formatter per timezone. Frozen: the memo computes each
 * constant's serialised signature ONCE per object identity, so a later
 * mutation would leave the cached signature stale and silently hand
 * callers a formatter built from the pre-mutation options.
 */
const VALIDATION_OPTIONS: Omit<Intl.DateTimeFormatOptions, "timeZone"> =
  Object.freeze({});

const HOUR_MINUTE_OPTIONS: Omit<Intl.DateTimeFormatOptions, "timeZone"> =
  Object.freeze({
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const WALL_CLOCK_PARTS_OPTIONS: Omit<Intl.DateTimeFormatOptions, "timeZone"> =
  Object.freeze({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/**
 * A zone id the runtime resolved to a bare UTC offset (`+05:30`, `-08:00`).
 */
const OFFSET_ZONE = /^[+-]\d/;

const validityByZone = new Map<string, boolean>();
const MAX_VALIDITY_ENTRIES = 256;

/**
 * Validate a timezone string: a named IANA zone (or `UTC`) the runtime
 * accepts. Returns `false` for anything else. Cheap (microseconds) — call
 * freely at write paths.
 *
 * Bare UTC offsets are refused although the runtime accepts them as zone ids.
 * The zone ends up in Postgres `AT TIME ZONE`, which reads a bare offset with
 * the POSIX sign (east of UTC is negative), so `+05:30` would cut every day
 * eleven hours off. Named zones, their aliases and the `Etc/GMT±N` family
 * mean the same thing to both.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== "string" || tz.length === 0 || tz.length > 64) {
    return false;
  }
  // The answer for a given name never changes within a process, and the
  // day-key helpers below ask it once per row; `resolvedOptions()` allocates
  // a fresh options object on every call.
  const memo = validityByZone.get(tz);
  if (memo !== undefined) return memo;
  let valid: boolean;
  try {
    // The memo only caches successful constructions, so probing an
    // invalid zone through it cannot poison the formatter map — and a
    // valid zone leaves its formatter warm for the real callers.
    const resolved = getDateTimeFormat(
      "en-US",
      tz,
      VALIDATION_OPTIONS,
    ).resolvedOptions().timeZone;
    valid = !OFFSET_ZONE.test(resolved);
  } catch {
    valid = false;
  }
  if (validityByZone.size >= MAX_VALIDITY_ENTRIES) validityByZone.clear();
  validityByZone.set(tz, valid);
  return valid;
}

/**
 * `tz` when it is a valid zone, else `fallback`. For every place a stored or
 * supplied zone reaches SQL: a value written before offsets were refused may
 * still sit in the database, and it must never be spliced.
 */
export function validTimezoneOr(
  tz: string | null | undefined,
  fallback: string,
): string {
  return tz && isValidTimezone(tz) ? tz : fallback;
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
  "iso-with-offset" | "wall-clock" | "datetime" | "date";

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
 *     `DEFAULT_TIMEZONE`.
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
      return getDateTimeFormat("en-GB", safeTz, HOUR_MINUTE_OPTIONS).format(
        date,
      );
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

/**
 * Shift a `YYYY-MM-DD` day key by `deltaDays` (negative steps back). Pure
 * calendar-day arithmetic, UTC-anchored so it never touches a timezone
 * offset or DST edge — the key is already a resolved local calendar date,
 * not an instant, so incrementing it needs no `tz` argument. Used by the
 * intraday-pulse day navigator (S11) to page `?date=` a day at a time
 * without re-deriving the viewer's timezone for a pure string increment.
 */
export function shiftDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `fromKey` to `toKey` (negative when `toKey` is
 * earlier). Pure key arithmetic like {@link shiftDateKey}: both keys are
 * already resolved calendar dates, so no zone takes part. `NaN` when either
 * key is malformed, so a caller decides what a bad key means.
 */
export function daysBetweenDateKeys(fromKey: string, toKey: string): number {
  const a = Date.parse(`${fromKey}T00:00:00.000Z`);
  const b = Date.parse(`${toKey}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Weekday of a calendar date key, 0 = Sunday … 6 = Saturday (the
 * `getDay()` / schedule `daysOfWeek` convention). A calendar date has the
 * same weekday in every zone, so this needs none.
 */
export function weekdayOfDateKey(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

/**
 * Wall-clock hour (0–23) an observer in `tz` reads off the clock at
 * `date`. Used for the time-of-day greeting so a traveller whose device
 * clock differs from their configured HealthLog zone still sees the right
 * salutation. Falls back to the UTC hour if the zone is unusable.
 */
export function hourInTz(date: Date, tz: string): number {
  const safeTz = isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE;
  const parsed = parseInt(wallClockParts(date, safeTz).hour, 10);
  return Number.isFinite(parsed) ? parsed % 24 : date.getUTCHours();
}

interface WallClockParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function wallClockParts(date: Date, tz: string): WallClockParts {
  const offsetMs = zoneOffsetMs(date, tz);
  if (offsetMs !== null) {
    const at = wallClockFromOffset(date, offsetMs);
    return {
      year: String(at.year),
      month: pad2(at.month),
      day: pad2(at.day),
      hour: pad2(at.hour),
      minute: pad2(at.minute),
      second: pad2(at.second),
    };
  }
  const fmt = getDateTimeFormat("en-CA", tz, WALL_CLOCK_PARTS_OPTIONS);
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
export function tzOffsetMinutes(date: Date, tz: string): number {
  const offsetMs = zoneOffsetMs(date, tz);
  if (offsetMs !== null) {
    // Same arithmetic as below: the wall clock is read to the whole second,
    // so the sub-second part of the instant shifts the rounded result.
    return Math.round((offsetMs - (date.getTime() % 1000)) / 60000);
  }
  const fmt = getDateTimeFormat("en-CA", tz, WALL_CLOCK_PARTS_OPTIONS);
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
