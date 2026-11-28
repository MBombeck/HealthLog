/**
 * The `since` / `until` window of the per-type CSV exports.
 *
 * The export card sends calendar days (`YYYY-MM-DD`), and both ends are
 * inclusive days in the account's time zone: "until 11 May" means the whole
 * of 11 May, local. Read as instants, `new Date("2026-05-11")` is 00:00 UTC,
 * so the last day was cut off entirely and the first one started at UTC
 * midnight instead of local midnight. A full instant (with a time) is still
 * taken as the exact bound it names, for API callers that send one.
 */
import { localDayWindow, startOfLocalDayKey } from "@/lib/tz/local-day";

export interface ExportRange {
  gte?: Date;
  /** Exclusive end: the first instant after the `until` day. */
  lt?: Date;
  /** Inclusive end, when `until` named an exact instant. */
  lte?: Date;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDay(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

function instant(value: string): Date | undefined {
  // A day that does not exist (30 February) is not a bound at all.
  if (DATE_KEY.test(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseExportRange(
  params: URLSearchParams,
  tz: string,
): ExportRange | undefined {
  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");
  const range: ExportRange = {};
  if (sinceRaw) {
    range.gte = isCalendarDay(sinceRaw)
      ? startOfLocalDayKey(sinceRaw, tz)
      : instant(sinceRaw);
  }
  if (untilRaw) {
    if (isCalendarDay(untilRaw)) {
      range.lt = localDayWindow(untilRaw, tz).dayEnd;
    } else {
      range.lte = instant(untilRaw);
    }
  }
  for (const key of ["gte", "lt", "lte"] as const) {
    if (range[key] === undefined) delete range[key];
  }
  return Object.keys(range).length > 0 ? range : undefined;
}
