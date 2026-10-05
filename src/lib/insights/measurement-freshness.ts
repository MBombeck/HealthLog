import { daysBetweenDateKeys } from "@/lib/tz/format";
/**
 * How old a reading may be before "today" stops being true about it.
 *
 * Several surfaces make present-tense statements out of the freshest stored
 * reading: the day-signals card ("one of your vitals is outside its usual
 * range today"), the baseline-drift card ("your pulse is above your usual
 * range"), and the narrated hero line on the dashboard. Every one of them was
 * handed "the latest value" with no notion of when it was taken, so a reading
 * from last week was narrated as this morning's — the reader is told something
 * about a day on which nothing was measured at all.
 *
 * The answer belongs beside the data, not beside each sentence. A reading is
 * material for a claim about today when it comes from today or from yesterday;
 * anything older is history, and history is stated with its date.
 *
 * The window is deliberately one day rather than zero. A vital taken at 23:40
 * and read at 00:10 is the same reading it was thirty minutes earlier, and a
 * morning weigh-in narrated that evening is still current. Two days is not:
 * by then a day has passed with no reading in it, and the sentence would be
 * describing a gap.
 */

/** Whole days of age a reading may carry and still support a present claim. */
export const TODAY_CLAIM_MAX_AGE_DAYS = 1;

/**
 * Whether a reading of this age may back a present-tense statement.
 *
 * An absent, negative or non-finite age answers `false`. A missing age is not
 * a fresh one, and it is exactly the case that produced the wrong sentence:
 * nothing knew how old the value was, so everything assumed it was new.
 */
export function isCurrentForTodayClaim(
  daysAgo: number | null | undefined,
): boolean {
  return (
    typeof daysAgo === "number" &&
    Number.isFinite(daysAgo) &&
    daysAgo >= 0 &&
    daysAgo <= TODAY_CLAIM_MAX_AGE_DAYS
  );
}

/**
 * Whether a reading was taken today, on the reader's own calendar.
 *
 * Stricter than {@link isCurrentForTodayClaim}, and the rule for every
 * sentence that says "today" in so many words or compares today against a
 * baseline: the Today overview on the dashboard, the signals of the day,
 * the "vitals outside their range today" card. A reading from yesterday
 * morning, read at nine in the evening, is not today's pulse, and saying so
 * describes a day on which nothing was measured. A metric with no reading
 * today is left out of those statements rather than worded with its age:
 * the quieter of the two answers, and the one that never asks for a
 * measurement nobody planned to take.
 *
 * `daysAgo` is the calendar distance in the reader's zone (as
 * {@link dayKeyAgeInDays} computes it), never elapsed hours: 23:40 and
 * 00:10 are different days, 00:10 and 23:50 the same one.
 */
export function isFromToday(daysAgo: number | null | undefined): boolean {
  return daysAgo === 0;
}

/**
 * Whole days between two `YYYY-MM-DD` local-day keys (`then` before `today`).
 *
 * Both keys are already resolved in the reader's own timezone by the caller,
 * so the arithmetic is plain calendar subtraction — parsing them as UTC
 * midnights keeps it free of any second zone conversion. A malformed key
 * answers `null` rather than a fabricated distance.
 */
export function dayKeyAgeInDays(then: string, today: string): number | null {
  const days = daysBetweenDateKeys(then, today);
  return Number.isFinite(days) ? days : null;
}
