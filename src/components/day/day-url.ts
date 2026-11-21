/**
 * The day layer's address: `?day=YYYY-MM-DD` on whatever page is open.
 *
 * Pure helpers, no React, so the rules the layer lives by (which dates open,
 * how the URL is spelled, what a step to the neighbouring day lands on) can be
 * pinned without mounting anything.
 *
 * A day opens only when it names a real calendar date that is not in the
 * future of the record's own zone. A future day has no content to show; a
 * link to one would be a dead end, so such a parameter is dropped quietly,
 * the same way `?add=` is on the measurements page.
 */
import type { DateKey } from "@/lib/day/contract";
import { isCalendarDateKey } from "@/lib/tz/date-only";
import { userDayKey } from "@/lib/tz/format";
import { getDateTimeFormat } from "@/lib/tz/intl-cache";

/**
 * The history-state marker of an entry the layer pushed itself. Closing such
 * an entry goes back one step; closing a deep link only edits the URL, so the
 * person stays on the page they arrived at.
 */
export const DAY_HISTORY_KEY = "__healthlogDayLayer";

/** Today's calendar date in `timeZone`, `YYYY-MM-DD`. */
export function todayKeyInZone(timeZone: string, now = new Date()): DateKey {
  // en-CA spells a date as YYYY-MM-DD; the same cached formatter family
  // `userDayKey` reads, kept here because this runs on every day-layer render.
  return getDateTimeFormat("en-CA", timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The calendar date of an instant in `timeZone`. */
export function dateKeyOfInstant(
  instant: Date | string | number,
  timeZone: string,
): DateKey {
  return userDayKey(new Date(instant), timeZone);
}

/** True when `key` is a real date on or before `todayKey`. */
export function isOpenableDay(
  key: string | null | undefined,
  todayKey: DateKey,
): key is DateKey {
  return typeof key === "string" && isCalendarDateKey(key) && key <= todayKey;
}

/** The parameter's day, or null when it names nothing the layer can open. */
export function parseDayParam(
  raw: string | null,
  todayKey: DateKey,
): DateKey | null {
  return isOpenableDay(raw, todayKey) ? raw : null;
}

/**
 * The day the docked day's strip holds: the open day, else the remembered
 * one while the layer would still open it, else today. The strip always
 * names a day, so it always has something to open.
 */
export function stripDayOf(
  open: DateKey | null,
  remembered: string | null,
  todayKey: DateKey,
): DateKey {
  return open ?? parseDayParam(remembered, todayKey) ?? todayKey;
}

/**
 * The history state the layer writes. Only application state: Next copies its
 * router fields onto the object itself, and copying `history.state` here would
 * carry them over and make Next treat the write as its own.
 */
export function dayHistoryState(key: DateKey): Record<string, unknown> {
  return { [DAY_HISTORY_KEY]: key };
}

/** True when the current history entry was pushed by the layer. */
export function historyEntryOwnedByLayer(state: unknown): boolean {
  return (
    state !== null &&
    typeof state === "object" &&
    typeof (state as Record<string, unknown>)[DAY_HISTORY_KEY] === "string"
  );
}
