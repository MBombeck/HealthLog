/**
 * Wall-clock-in-timezone helper shared by the medication scheduling
 * + compliance-rollup paths.
 *
 * Decomposes a `Date` instant into the year/month/day/hour/minute/
 * second/weekday tuple an observer in `tz` would read off a wall
 * clock at that moment. Honours DST because `Intl.DateTimeFormat`
 * does.
 *
 * When `tz` is omitted the helper falls back to the host's system-
 * local representation so the v1.4.25 W19e callers that pre-date the
 * per-user timezone work keep their original shape.
 *
 * v1.4.40 W-GHOSTS consolidated two file-local copies
 * (`compliance-rollups.ts` returning `{year,month,day}` only +
 * `scheduling/cadence.ts` returning the full tuple) into this single
 * canonical export. The cross-tz ±3 h guard hinges on these helpers
 * staying in lock-step; keeping them as separate definitions made
 * silent drift a real failure mode.
 */
import { getDateTimeFormat } from "./intl-cache";
import { wallClockFromOffset, zoneOffsetMs } from "./zone-offset";

export interface WallClockParts {
  year: number;
  /** 1–12 (January = 1, December = 12). */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23 (24 normalised to 0 to match Date.getHours() semantics). */
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Hoisted so the formatter memo's WeakMap signature lookup hits the same
 * object identity on every call — a warm `wallClockInTz` no longer pays
 * `Intl.DateTimeFormat` construction (the dominant cost of the band
 * expansion + rollup paths that call this in a tight loop). Frozen: the
 * memo serialises the signature ONCE per object identity, so a later
 * mutation would leave the cached signature stale.
 */
const WALL_CLOCK_OPTIONS: Omit<Intl.DateTimeFormatOptions, "timeZone"> =
  Object.freeze({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });

/**
 * The wall-clock fields a `zonedWallClockToUtc` caller supplies. Months are
 * 1-based to match `WallClockParts`; second defaults to 0 when omitted.
 */
export interface WallClockInput {
  year: number;
  /** 1–12 (January = 1, December = 12). */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second?: number;
}

/**
 * Inverse of `wallClockInTz`: given the wall-clock an observer in `tz` reads
 * (e.g. an offset-less `2020-01-26T03:02:30` Fitbit sleep timestamp), return the
 * UTC instant it denotes. DST-safe via the same two-pass converge as
 * `startOfLocalDayInTz` — the second pass settles the zone offset across a DST
 * transition for every IANA zone. When `tz` is omitted the parts are read as the
 * host's system-local clock so offset-less callers keep their legacy shape.
 */
export function zonedWallClockToUtc(
  parts: WallClockInput,
  tz: string | undefined,
): Date {
  const second = parts.second ?? 0;
  if (!tz) {
    return new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      second,
      0,
    );
  }
  // Treat the wall clock as if it were UTC, then correct by the zone offset at
  // that approximate instant; one extra pass settles the DST boundary.
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    second,
    0,
  );
  let guess = new Date(asIfUtc);
  for (let i = 0; i < 2; i++) {
    const at = wallClockInTz(guess, tz);
    const guessAsIfUtc = Date.UTC(
      at.year,
      at.month - 1,
      at.day,
      at.hour,
      at.minute,
      at.second,
      0,
    );
    const offsetMin = Math.round((guessAsIfUtc - guess.getTime()) / 60_000);
    guess = new Date(asIfUtc - offsetMin * 60_000);
  }
  const settled = wallClockInTz(guess, tz);
  if (
    settled.year === parts.year &&
    settled.month === parts.month &&
    settled.day === parts.day &&
    settled.hour === parts.hour &&
    settled.minute === parts.minute
  ) {
    return guess;
  }
  // The wall clock does not exist: a DST change skips it (00:00 on the
  // spring-forward day in America/Santiago, 02:30 in Europe/Berlin). Read it
  // with the offset in force BEFORE the gap, which lands the same distance
  // past the change (00:00 becomes 01:00), the way a wall clock reads when
  // it is set forward. The converge alone could settle on the previous day.
  let before = Infinity;
  for (const delta of [-14, 0, 14]) {
    const probe = new Date(asIfUtc + delta * 3_600_000);
    const at = wallClockInTz(probe, tz);
    const offset = Math.round(
      (Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) -
        probe.getTime()) /
        60_000,
    );
    if (offset < before) before = offset;
  }
  return new Date(asIfUtc - before * 60_000);
}

/**
 * The local calendar day as a day index, for day-distance arithmetic
 * between two wall clocks in the SAME zone.
 *
 * Built from the wall-clock fields through `Date.UTC`, so the difference
 * of two indices is a pure calendar-day count: no host offset and no
 * 23 h/25 h DST-length term can enter it. Subtracting two instants and
 * dividing by 86 400 000 does admit both, which is how a "tomorrow" label
 * could land on a transition day.
 */
export function localDayIndex(parts: WallClockParts): number {
  return Math.floor(
    Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000,
  );
}

export function wallClockInTz(
  date: Date,
  tz: string | undefined,
): WallClockParts {
  if (!tz) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
      weekday: date.getDay(),
    };
  }
  const offsetMs = zoneOffsetMs(date, tz);
  if (offsetMs !== null) return wallClockFromOffset(date, offsetMs);
  const parts = getDateTimeFormat(
    "en-US",
    tz,
    WALL_CLOCK_OPTIONS,
  ).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_MAP[get("weekday")] ?? 0,
  };
}
