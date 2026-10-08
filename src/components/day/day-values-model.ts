/**
 * Which of a day's values the view shows first, and how they pair up.
 *
 * Pure, so the curation can be pinned without rendering. The server sends one
 * row per type (canonical source, band already decided); this only orders the
 * rows and folds the two halves of a blood pressure into one tile, because a
 * reading of 138 over 88 is one thing to a person, not two.
 */
import type { DayValue } from "@/lib/day/contract";

/** How many tiles the day shows before "All values". */
export const CURATED_VALUE_COUNT = 8;

/**
 * The order a person reads a day in: the core vitals first, then sleep and
 * movement, then the rest. A type not listed comes after every listed one,
 * in the order the server sent it.
 */
export const VALUE_PRIORITY: readonly string[] = [
  "BLOOD_PRESSURE_SYS",
  "RESTING_HEART_RATE",
  "PULSE",
  "WEIGHT",
  "BODY_TEMPERATURE",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
  "HEART_RATE_VARIABILITY",
  "HRV_RMSSD",
  "BLOOD_GLUCOSE",
  "OXYGEN_SATURATION",
  "RESPIRATORY_RATE",
  "BODY_FAT",
];

export interface DayValueTile {
  /** Stable key: the first type, `BLOOD_PRESSURE` for the pair. */
  key: string;
  /** The rows the tile shows, systolic before diastolic for the pair. */
  values: DayValue[];
}

/** The tile key a type belongs to. */
export function tileKeyOf(type: string): string {
  return type === "BLOOD_PRESSURE_SYS" || type === "BLOOD_PRESSURE_DIA"
    ? "BLOOD_PRESSURE"
    : type;
}

/**
 * Fold, order and split the day's values. `focusTypes` (the value the person
 * came from) always lands among the first tiles, wherever its type ranks.
 */
export function curateDayValues(
  values: readonly DayValue[],
  focusTypes: readonly string[] = [],
): { curated: DayValueTile[]; rest: DayValueTile[] } {
  const tiles = new Map<string, DayValueTile>();
  for (const value of values) {
    const key = tileKeyOf(value.type);
    const tile = tiles.get(key) ?? { key, values: [] };
    tile.values.push(value);
    tiles.set(key, tile);
  }
  for (const tile of tiles.values()) {
    if (tile.key === "BLOOD_PRESSURE") {
      tile.values.sort((a, b) =>
        a.type === b.type ? 0 : a.type === "BLOOD_PRESSURE_SYS" ? -1 : 1,
      );
    }
  }

  const rank = (tile: DayValueTile): number => {
    const first =
      tile.key === "BLOOD_PRESSURE" ? "BLOOD_PRESSURE_SYS" : tile.key;
    const index = VALUE_PRIORITY.indexOf(first);
    return index === -1 ? VALUE_PRIORITY.length : index;
  };
  const sent = [...tiles.values()];
  const ordered = sent
    .map((tile, arrival) => ({ tile, arrival }))
    .sort((a, b) => rank(a.tile) - rank(b.tile) || a.arrival - b.arrival)
    .map(({ tile }) => tile);

  const focusKeys = new Set(focusTypes.map(tileKeyOf));
  const focused = ordered.filter((tile) => focusKeys.has(tile.key));
  const others = ordered.filter((tile) => !focusKeys.has(tile.key));
  const head = [...focused, ...others].slice(0, CURATED_VALUE_COUNT);
  const headKeys = new Set(head.map((tile) => tile.key));
  // Keep the reading order inside the first tiles: the focus is marked, not
  // moved to the front.
  const curated = ordered.filter((tile) => headKeys.has(tile.key));
  const rest = ordered.filter((tile) => !headKeys.has(tile.key));
  return { curated, rest };
}

/**
 * Where a value and its usual range sit on a short line, in percent. The
 * line spans the band with room on both sides so a value inside the range
 * reads as inside, and stretches to include a value outside it.
 */
export function numberLinePositions(
  value: number,
  band: { lo: number; hi: number },
): { lo: number; hi: number; point: number } {
  const lo = Math.min(band.lo, band.hi);
  const hi = Math.max(band.lo, band.hi);
  const span = hi - lo || Math.max(Math.abs(hi) * 0.1, 1);
  let min = lo - span * 0.75;
  let max = hi + span * 0.75;
  if (value < min) min = value - span * 0.15;
  if (value > max) max = value + span * 0.15;
  const width = max - min;
  const at = (n: number) =>
    Math.round(Math.min(100, Math.max(0, ((n - min) / width) * 100)) * 10) / 10;
  return { lo: at(lo), hi: at(hi), point: at(value) };
}
