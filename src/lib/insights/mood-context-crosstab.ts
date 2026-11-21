/**
 * Day context against the day's mood, with the count on every statement.
 *
 * The question this answers is "on the days you recorded a conflict, how did
 * the mood value sit against the days you did not" — and the answer is a
 * comparison, never a cause. Nothing in this file, and nothing rendered from
 * it, may say that a context value made a day worse. It did not, and the data
 * cannot know whether it did.
 *
 * The statistics are borrowed rather than rebuilt. The Welch t-test, the
 * Benjamini-Hochberg step-up, the per-side day floors and the FDR threshold
 * all come from the machinery the tag crosstab already runs. That matters more
 * here than it sounds: a context sweep tests a few dozen values at once, and a
 * raw p < 0.05 over that many comparisons surfaces one-in-twenty noise as a
 * finding. The BH correction is the difference between a board that means
 * something and a board that always has something on it.
 *
 * The floors are constants with names because Phase 3's model will import
 * them rather than declare a second set that drifts from these.
 */
import {
  CROSSTAB_FDR_Q,
  CROSSTAB_MIN_ABSENT_DAYS,
  CROSSTAB_MIN_PRESENT_DAYS,
} from "@/lib/insights/mood-crosstab";
import { benjaminiHochberg } from "@/lib/insights/correlation-discovery";
import { welchTTest } from "@/lib/insights/correlations";
import {
  CONTACT_CIRCLE_KEYS,
  CONTACT_EXTENT_KEYS,
  CONTACT_FORM_KEYS,
  EVENT_TYPE_KEYS,
  LEISURE_CATEGORY_KEYS,
  WORK_STATUS_KEYS,
  decodeKeyList,
} from "@/lib/mood/context-vocabulary";
import { mean } from "@/lib/stats/central";

/**
 * The smallest number of days a context value may be seen on and still be
 * shown at all.
 *
 * Five is the floor the rest of the mood surfaces already use, and it is a
 * floor rather than a target: the concept that shaped this feature asks for
 * ten, and a reader looking at a row backed by five days should be able to see
 * that number and discount it accordingly. Which is why the count is on the
 * statement and not in a tooltip.
 */
export const CONTEXT_MIN_PRESENT_DAYS = CROSSTAB_MIN_PRESENT_DAYS;
export const CONTEXT_MIN_ABSENT_DAYS = CROSSTAB_MIN_ABSENT_DAYS;
/** Most rows the board shows, so it stays readable rather than exhaustive. */
export const CONTEXT_MAX_ROWS = 8;

/** One row of a stored context, as the comparison reads it. */
export interface ContextDayRow {
  /** The entry's local day. One row per day; a second entry on a day is folded. */
  day: string;
  /** The day's pleasantness value, 0-10. Days without one are skipped. */
  moodA1: number | null;
  workStatus: string | null;
  contactCircles: string | null;
  contactForm: string | null;
  contactExtent: string | null;
  leisureCategories: string | null;
  eventType: string | null;
}

export interface ContextComparisonRow {
  /** Which context field this row is about, e.g. `workStatus`. */
  field: string;
  /** The value inside that field, e.g. `overtime`. */
  value: string;
  /** Days the value was recorded and the day had a mood value. */
  withDays: number;
  /** Days it was not, and the day had a mood value. */
  withoutDays: number;
  /** Mean pleasantness on days carrying the value. */
  withAvg: number;
  /** Mean pleasantness on the other days. */
  withoutAvg: number;
  /** `withAvg - withoutAvg`. Signed, and never described as an effect. */
  delta: number;
  pValue: number;
  qValue: number;
}

/** The single-valued fields, and the vocabulary each draws from. */
const SINGLE_FIELDS: Array<{
  field: keyof ContextDayRow & string;
  keys: readonly string[];
}> = [
  { field: "workStatus", keys: WORK_STATUS_KEYS },
  { field: "contactForm", keys: CONTACT_FORM_KEYS },
  { field: "contactExtent", keys: CONTACT_EXTENT_KEYS },
  { field: "eventType", keys: EVENT_TYPE_KEYS },
];

/** The multi-select fields, stored as JSON arrays in a string column. */
const MULTI_FIELDS: Array<{
  field: keyof ContextDayRow & string;
  keys: readonly string[];
}> = [
  { field: "contactCircles", keys: CONTACT_CIRCLE_KEYS },
  { field: "leisureCategories", keys: LEISURE_CATEGORY_KEYS },
];

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Compare every context value against the day's pleasantness.
 *
 * Pure over already-fetched rows, with the database read left to the caller —
 * the shape `mood-aggregates.ts` uses, so the whole comparison is testable
 * without a container.
 */
export function computeContextMoodComparison(
  rows: readonly ContextDayRow[],
): ContextComparisonRow[] {
  // One observation per day. Two entries on one day would otherwise weight
  // that day twice, and a day somebody logged three times is not three days.
  const byDay = new Map<string, ContextDayRow>();
  for (const row of rows) {
    if (row.moodA1 === null) continue;
    if (!byDay.has(row.day)) byDay.set(row.day, row);
  }
  if (byDay.size === 0) return [];
  const days = [...byDay.values()];

  const candidates: ContextComparisonRow[] = [];

  const test = (
    field: string,
    value: string,
    carries: (row: ContextDayRow) => boolean,
  ) => {
    const withVals: number[] = [];
    const withoutVals: number[] = [];
    for (const row of days) {
      // `moodA1` is non-null by construction above; the guard keeps the
      // narrowing local rather than asserting it.
      if (row.moodA1 === null) continue;
      if (carries(row)) withVals.push(row.moodA1);
      else withoutVals.push(row.moodA1);
    }
    if (
      withVals.length < CONTEXT_MIN_PRESENT_DAYS ||
      withoutVals.length < CONTEXT_MIN_ABSENT_DAYS
    ) {
      return;
    }
    const withAvg = mean(withVals);
    const withoutAvg = mean(withoutVals);
    if (withAvg === null || withoutAvg === null) return;
    const delta = withAvg - withoutAvg;
    if (delta === 0) return;
    const welch = welchTTest(withVals, withoutVals);
    candidates.push({
      field,
      value,
      withDays: withVals.length,
      withoutDays: withoutVals.length,
      withAvg: round(withAvg, 2),
      withoutAvg: round(withoutAvg, 2),
      delta: round(delta, 2),
      pValue: welch.status === "ok" ? welch.pValue : 1,
      qValue: 1,
    });
  };

  for (const { field, keys } of SINGLE_FIELDS) {
    for (const value of keys) {
      test(field, value, (row) => row[field] === value);
    }
  }
  for (const { field, keys } of MULTI_FIELDS) {
    for (const value of keys) {
      test(field, value, (row) =>
        decodeKeyList(row[field] as string | null).includes(value),
      );
    }
  }

  if (candidates.length === 0) return [];

  // One family across every field × value pair tested. Correcting per field
  // would be six small families instead of one honest one, and the whole
  // reason to correct is that the sweep is wide.
  const qValues = benjaminiHochberg(candidates.map((c) => c.pValue));

  return candidates
    .map((c, i) => ({ ...c, qValue: round(qValues[i], 3) }))
    .filter((row) => row.pValue < 0.05 && row.qValue <= CROSSTAB_FDR_Q)
    .sort(
      (a, b) =>
        a.qValue - b.qValue ||
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.value.localeCompare(b.value),
    )
    .slice(0, CONTEXT_MAX_ROWS);
}
