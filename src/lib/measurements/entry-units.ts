/**
 * Where the entry form asks for one unit and the column stores another.
 *
 * This is not the metric/imperial display transform in `display-transform.ts`:
 * that one follows a preference and is the identity for anyone on metric. This
 * one holds regardless of preference, because the storage unit was chosen for
 * the sync sources rather than for the person typing.
 *
 * Sleep is the case. `SLEEP_DURATION` is stored in minutes — every provider
 * delivers minutes, and a per-stage segment is only a few of them — while a
 * person logging a night by hand thinks in hours and the field says so. The
 * form sent the typed number straight through, so a night entered as 7.5 was
 * stored as seven and a half MINUTES and read back on the list as eight
 * minutes of sleep. Nothing rejected it: seven and a half minutes is inside
 * the column's plausibility band, because a single sleep STAGE really can be
 * that short.
 *
 * The storage unit stays minutes. The conversion belongs at the entry
 * boundary, in one place, so a second surface that starts taking sleep by hand
 * has one answer to reach for rather than its own.
 *
 * Only the direction that exists is here. An inverse and a "does this type
 * convert" predicate shipped alongside it at first, written for an editing
 * surface that does not exist and has no ticket; they were nothing but two
 * more things to keep true. The git history holds them if that surface ever
 * arrives.
 */

import type { DurationFieldUnit } from "./parse-duration";
import { ownValue } from "@/lib/own-key";

export const MINUTES_PER_HOUR = 60;

/**
 * Types whose entry field asks for a duration, and the unit it asks in. Such a
 * field reads `7:30` and `7h 30m` as well as a decimal (`parseDurationEntry`).
 */
const DURATION_ENTRY_UNIT: Readonly<Record<string, DurationFieldUnit>> = {
  SLEEP_DURATION: "h",
};

/** The duration unit a type's entry field asks in, or null for a plain number. */
export function durationEntryUnit(type: string): DurationFieldUnit | null {
  return ownValue(DURATION_ENTRY_UNIT, type) ?? null;
}

/**
 * Entry unit → canonical unit multiplier, per measurement type. A type absent
 * from this table enters in the unit it is stored in.
 */
const ENTRY_TO_CANONICAL_FACTOR: Readonly<Record<string, number>> = {
  SLEEP_DURATION: MINUTES_PER_HOUR,
};

/**
 * Convert a value as typed in the entry form to the unit the column stores.
 *
 * The result is rounded to the nearest whole canonical unit for a converted
 * type: 7.3 hours is 438 minutes, and floating-point multiplication would
 * otherwise store 437.99999999999994 for it. An unconverted type is returned
 * untouched, so no existing metric changes shape.
 */
export function entryValueToCanonical(type: string, entered: number): number {
  const factor = ownValue(ENTRY_TO_CANONICAL_FACTOR, type);
  if (factor === undefined || !Number.isFinite(entered)) return entered;
  return Math.round(entered * factor);
}

/**
 * Read a number out of an entry field, accepting the decimal comma.
 *
 * Most of the application's readers are German, and "7,5" is how they write
 * seven and a half. `parseFloat` reads that as 7 and discards the rest without
 * complaint — the worst shape of wrong, since the entry looks accepted.
 * Returns `null` for anything that is not a number, so the caller decides what
 * an empty field means rather than inheriting a `NaN`.
 */
export function parseDecimalEntry(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
