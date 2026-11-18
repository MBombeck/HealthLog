/**
 * How one day's nutrient rows add up to the day's intake.
 *
 * A day can carry one row per source. Two kinds of source exist:
 *
 *   - day-total sources (`DAY_TOTAL_SOURCES`: a bridge, Apple Health, Health
 *     Connect) each report everything eaten that day, and usually report the
 *     same meals. Only the LARGEST of them counts; the others are left out.
 *   - additive sources (water entered by hand, taken supplement doses, and any
 *     source outside the closed set) report something no tracker saw, so they
 *     add on top.
 *
 * `bySource` names only the rows that counted, so its values always sum to
 * `total`. Every summation of nutrient rows reads this one fold, so no two
 * surfaces disagree about a day.
 */
import {
  DAY_TOTAL_SOURCES,
  isNutrientSource,
  type NutrientSource,
} from "@/lib/nutrients/sources";

/** A day's amount split by source; a source that did not count is absent. */
export type NutrientAmountBySource = Partial<Record<NutrientSource, number>>;

export interface NutrientDayRow {
  source: string;
  amount: number;
}

export interface NutrientDayFold {
  total: number;
  bySource: NutrientAmountBySource;
}

const DAY_TOTAL_SET: ReadonlySet<string> = new Set(DAY_TOTAL_SOURCES);

/** Fold one day's rows (one nutrient) into the day's total and its split. */
export function foldNutrientDay(
  rows: ReadonlyArray<NutrientDayRow>,
): NutrientDayFold {
  let total = 0;
  const bySource: NutrientAmountBySource = {};

  // The largest day-total row, ties broken by `DAY_TOTAL_SOURCES` order.
  let winner: NutrientDayRow | null = null;
  for (const row of rows) {
    if (!DAY_TOTAL_SET.has(row.source)) continue;
    if (
      winner === null ||
      row.amount > winner.amount ||
      (row.amount === winner.amount &&
        DAY_TOTAL_SOURCES.indexOf(row.source as NutrientSource) <
          DAY_TOTAL_SOURCES.indexOf(winner.source as NutrientSource))
    ) {
      winner = row;
    }
  }
  if (winner !== null) {
    total += winner.amount;
    bySource[winner.source as NutrientSource] = winner.amount;
  }

  for (const row of rows) {
    if (DAY_TOTAL_SET.has(row.source)) continue;
    total += row.amount;
    // A source outside the closed set still counts toward the total; it only
    // cannot be named in the split.
    if (isNutrientSource(row.source)) {
      bySource[row.source] = (bySource[row.source] ?? 0) + row.amount;
    }
  }
  return { total, bySource };
}

/**
 * Group rows by a key (day, or day and nutrient) and fold each group. The
 * caller picks the key; the fold is the same.
 */
export function foldNutrientDays<T extends NutrientDayRow>(
  rows: ReadonlyArray<T>,
  keyOf: (row: T) => string,
): Map<string, NutrientDayFold> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const folds = new Map<string, NutrientDayFold>();
  for (const [key, group] of groups) folds.set(key, foldNutrientDay(group));
  return folds;
}
