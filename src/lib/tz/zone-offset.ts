/**
 * Per-hour memo of a zone's UTC offset, so wall-clock conversions in hot loops
 * stop paying for `Intl.DateTimeFormat#formatToParts` on every row.
 *
 * A day-key or wall-clock read is pure arithmetic once the offset in force at
 * the instant is known. The offset is probed through the same cached
 * formatter the slow path uses, at both ends of the UTC hour that contains the
 * instant; only when both ends agree (and the offset is a whole number of
 * seconds) is it memoised for that hour. An hour that straddles a transition
 * is stored as "not constant" and every instant inside it keeps going through
 * the formatter, so a transition at any minute — Lord Howe's half-hour shift
 * at 15:30 UTC, a historical LMT offset with seconds — still resolves exactly.
 *
 * The fast path is limited to 1971..2199 so the arithmetic never meets the
 * Julian / proleptic-Gregorian split or a non-four-digit year, and so `t % 1000`
 * is never negative. Outside that range, for an invalid date, or for a zone
 * the formatter rejects, callers fall through to the formatter unchanged
 * (an invalid zone throws from the probe exactly as it throws from the
 * formatter path, and a value that is not a Date is left to the formatter).
 */
import { getDateTimeFormat } from "./intl-cache";

const PROBE_OPTIONS: Omit<Intl.DateTimeFormatOptions, "timeZone"> =
  Object.freeze({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const BUCKET_MS = 3_600_000;
const FAST_FROM_MS = Date.UTC(1971, 0, 1);
const FAST_UNTIL_MS = Date.UTC(2200, 0, 1);
/** Hours memoised across all zones before the memo starts over (~2 MB). */
const MAX_BUCKETS = 20_000;
/** Stored for an hour whose offset changes inside it. */
const NOT_CONSTANT = Number.NaN;

const offsetsByZone = new Map<string, Map<number, number>>();
let bucketCount = 0;

/** Exact offset (ms) at an instant that falls on a whole second. */
function probeOffsetMs(instantMs: number, tz: string): number {
  const parts = getDateTimeFormat("en-CA", tz, PROBE_OPTIONS).formatToParts(
    new Date(instantMs),
  );
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value);
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
    }
  }
  if (hour === 24) hour = 0;
  return Date.UTC(year, month - 1, day, hour, minute, second) - instantMs;
}

/**
 * The zone's offset from UTC in milliseconds at `date`, or `null` when the
 * caller must use the formatter (out of range, invalid date, or an hour that
 * contains a transition). Throws for a zone `Intl` rejects.
 */
export function zoneOffsetMs(date: Date, tz: string): number | null {
  // A caller that slips a non-Date through (an absent field read off a loose
  // row) keeps the formatter's own handling: `formatToParts(undefined)`
  // formats the current instant rather than throwing.
  if (!(date instanceof Date)) return null;
  const t = date.getTime();
  if (!(t >= FAST_FROM_MS && t < FAST_UNTIL_MS)) return null;
  const bucket = Math.floor(t / BUCKET_MS);
  let zone = offsetsByZone.get(tz);
  const memo = zone?.get(bucket);
  if (memo !== undefined) return Number.isNaN(memo) ? null : memo;

  const start = bucket * BUCKET_MS;
  const atStart = probeOffsetMs(start, tz);
  const atEnd = probeOffsetMs(start + BUCKET_MS - 1000, tz);
  const offset =
    atStart === atEnd && atStart % 1000 === 0 ? atStart : NOT_CONSTANT;

  if (bucketCount >= MAX_BUCKETS) {
    offsetsByZone.clear();
    bucketCount = 0;
    zone = undefined;
  }
  if (!zone) {
    zone = new Map();
    offsetsByZone.set(tz, zone);
  }
  zone.set(bucket, offset);
  bucketCount += 1;
  return Number.isNaN(offset) ? null : offset;
}

/** Wall-clock fields at `date` in the zone whose offset is `offsetMs`. */
export function wallClockFromOffset(
  date: Date,
  offsetMs: number,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
} {
  const local = new Date(date.getTime() + offsetMs);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    weekday: local.getUTCDay(),
  };
}

export function __resetZoneOffsetCacheForTests(): void {
  offsetsByZone.clear();
  bucketCount = 0;
}
