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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(date);
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
