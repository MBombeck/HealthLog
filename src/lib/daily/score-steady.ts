/**
 * "Steady for N weeks": how long the health score has held where it is.
 *
 * The score moves slowly on purpose (long windows against reference bands),
 * so on most days the honest thing to say about it is not a delta but how long
 * it has stayed put. That is a real statement only when it comes with a
 * duration read off the record, which is what this does: it walks the stored
 * daily scores (`HealthScoreRecord`) back from the newest and counts how long
 * the number held.
 *
 * A day belongs to the run while it was computed the same way (same algorithm
 * version, same composition), sat in the same band, and stayed within
 * {@link STEADY_TOLERANCE} points of the newest value, and the newest stored
 * day must match the score on screen the same way. A gap in the record
 * longer than {@link STEADY_MAX_GAP_DAYS} ends the run: an absence is not
 * evidence of steadiness.
 */
import { addDays, dayDiff } from "@/lib/cycle/day-math";

/** Points either side of the newest value that still count as "the same". */
export const STEADY_TOLERANCE = 2;

/** Longest stretch without a stored score the run may bridge. */
export const STEADY_MAX_GAP_DAYS = 3;

/** Shortest run worth saying out loud. One week is not yet a pattern. */
export const STEADY_MIN_WEEKS = 2;

/** How far back the read looks; also the longest run it can report. */
export const STEADY_READ_DAYS = 120;

export interface StoredScoreDay {
  dayKey: string;
  composite: number;
  band: string;
  scoreVersion: number;
  composition: readonly string[];
}

function sameComposition(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** The score the ring shows, as the run is compared against it. */
export interface ShownScore {
  value: number;
  band: string;
  /** Absent on an older snapshot; then only value and band are compared. */
  scoreVersion?: number;
  composition?: readonly string[];
}

/** How long the score has held. */
export interface SteadyRun {
  /** Whole weeks the run covers, counted over stored days that were read. */
  weeks: number;
  /**
   * True when the run reaches the start of what was read
   * ({@link STEADY_READ_DAYS}): the score has held at least `weeks`, and when
   * it started is not known. Said as "at least", never as a start.
   */
  atLeast: boolean;
}

function sameBand(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * How long the score has held, or null when it has not held for at least
 * {@link STEADY_MIN_WEEKS}. `rows` may come in any order; `todayKey` is the
 * reader's local day, so a record that stopped updating days ago does not
 * claim a run that reaches today. The newest stored day must also agree with
 * the score on screen in value, band and, where the screen says, algorithm
 * version and composition: the ring is computed live, the record nightly,
 * and a run that ended overnight is not "steady" next to a number, or a band,
 * that has moved.
 */
export function steadyRun(
  rows: readonly StoredScoreDay[],
  todayKey: string,
  /** The score the ring shows; a run that does not end there is not told. */
  shown: ShownScore,
): SteadyRun | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    a.dayKey < b.dayKey ? 1 : a.dayKey > b.dayKey ? -1 : 0,
  );
  const newest = sorted[0];
  if (dayDiff(todayKey, newest.dayKey) > STEADY_MAX_GAP_DAYS) return null;
  if (Math.abs(newest.composite - shown.value) > STEADY_TOLERANCE) return null;
  if (!sameBand(newest.band, shown.band)) return null;
  if (
    shown.scoreVersion !== undefined &&
    newest.scoreVersion !== shown.scoreVersion
  ) {
    return null;
  }
  if (
    shown.composition !== undefined &&
    !sameComposition(newest.composition, shown.composition)
  ) {
    return null;
  }

  let oldest = newest;
  let broke = false;
  for (const row of sorted.slice(1)) {
    if (
      dayDiff(oldest.dayKey, row.dayKey) > STEADY_MAX_GAP_DAYS ||
      row.scoreVersion !== newest.scoreVersion ||
      !sameComposition(row.composition, newest.composition) ||
      !sameBand(row.band, newest.band) ||
      Math.abs(row.composite - newest.composite) > STEADY_TOLERANCE
    ) {
      broke = true;
      break;
    }
    oldest = row;
  }

  const weeks = Math.floor(dayDiff(todayKey, oldest.dayKey) / 7);
  if (weeks < STEADY_MIN_WEEKS) return null;
  // Nothing ended the run inside what was read, and what was read ends
  // within a bridgeable gap of the read's own start: the run may go back
  // further than anything here can tell.
  const atLeast =
    !broke &&
    dayDiff(oldest.dayKey, addDays(todayKey, -STEADY_READ_DAYS)) <=
      STEADY_MAX_GAP_DAYS;
  return { weeks, atLeast };
}
