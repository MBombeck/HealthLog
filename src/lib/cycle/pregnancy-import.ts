/**
 * Apple Health pregnancy and lactation samples → the cycle's pregnancy
 * state.
 *
 * An `export.xml` carries `HKCategoryTypeIdentifierPregnancy` and
 * `HKCategoryTypeIdentifierLactation` as category samples with a start and an
 * end. They are status, not day logs, so they never become a `CycleDayLog`.
 * What they may do is set the profile's state, and only conservatively:
 *
 *   - An ongoing pregnancy sample (its end is today or later, or missing)
 *     sets PREGNANT with the sample's first day as the pregnancy's first day.
 *     The due date is not read off the sample; the owner adds it.
 *   - An ongoing lactation sample sets POSTPARTUM only when a pregnancy
 *     sample ended at most 14 days before the lactation began; that end is
 *     the delivery date. A pregnancy that ended without a lactation sample
 *     beside it sets nothing: an ended pregnancy is not always a birth, and
 *     the import does not guess which.
 *   - Nothing here overrides the owner. The caller applies a decision only
 *     while the profile holds no state and the owner has never set or cleared
 *     one in the cycle settings, so a state the owner cleared is not set
 *     again on the next import.
 */
import { dayDiff } from "./day-math";

/** How far before a lactation start a pregnancy may have ended. */
const DELIVERY_TO_LACTATION_MAX_DAYS = 14;

/** One status sample, as user-local calendar days. */
export interface StatusSample {
  start: string;
  /** Null when the sample is still open. */
  end: string | null;
}

export type ImportedPregnancyDecision =
  | { state: "PREGNANT"; startDate: string; sampleStart: string }
  | { state: "POSTPARTUM"; deliveryDate: string; sampleStart: string }
  | null;

function ongoing(sample: StatusSample, today: string): boolean {
  return sample.end === null || sample.end >= today;
}

function latestFirst(a: StatusSample, b: StatusSample): number {
  return b.start.localeCompare(a.start);
}

/** The state the samples support on `today`, or null. */
export function decideImportedPregnancyState(
  pregnancies: readonly StatusSample[],
  lactations: readonly StatusSample[],
  today: string,
): ImportedPregnancyDecision {
  const openPregnancy = [...pregnancies]
    .filter((p) => ongoing(p, today) && p.start <= today)
    .sort(latestFirst)[0];
  if (openPregnancy) {
    return {
      state: "PREGNANT",
      startDate: openPregnancy.start,
      sampleStart: openPregnancy.start,
    };
  }

  const openLactation = [...lactations]
    .filter((l) => ongoing(l, today) && l.start <= today)
    .sort(latestFirst)[0];
  if (!openLactation) return null;
  const birth = pregnancies
    .filter((p) => p.end !== null)
    .map((p) => p.end as string)
    .filter((end) => {
      const gap = dayDiff(openLactation.start, end);
      return gap >= 0 && gap <= DELIVERY_TO_LACTATION_MAX_DAYS;
    })
    .sort()
    .at(-1);
  if (!birth) return null;
  return {
    state: "POSTPARTUM",
    deliveryDate: birth,
    sampleStart: openLactation.start,
  };
}
