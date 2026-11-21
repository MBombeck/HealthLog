/**
 * Pregnancy and postpartum as a cycle state (v1.49).
 *
 * The owner sets the state on `CycleProfile`; this module resolves what it
 * means on a given day. It is pure: every caller passes the owner's own
 * calendar day, so the answer near midnight agrees with the calendar.
 *
 *   - PREGNANT holds until the owner changes it. The week is counted the
 *     usual way, in completed weeks and days from the first day of the
 *     pregnancy (`pregnancyStartDate`), or from the due date less 280 days
 *     when only the due date is known. Neither known: no week, the state
 *     still holds.
 *   - POSTPARTUM holds from `deliveryDate` for `postpartumWeeks` weeks, then
 *     resolves to the ordinary cycle on its own.
 *
 * While the resolved state is set the period and fertility forecast pauses
 * (`predictionsPaused`). That is the one predicate: the engine gate, the
 * forecast cache refresh, the reminder cron, the calendar feed, the Coach
 * block and the iOS DTO all read it, so no surface keeps predicting a period
 * that is not coming.
 *
 * Present data only. Nothing here says what a week means, and nothing here
 * scores anything.
 */
import { addDays, dayDiff } from "./day-math";
import type { CycleReproductiveState } from "./types";

/** Days from the first day of the pregnancy to the due date. */
export const PREGNANCY_TERM_DAYS = 280;

/** Default length of the postpartum state, in weeks. */
export const POSTPARTUM_WEEKS_DEFAULT = 12;
export const POSTPARTUM_WEEKS_MIN = 1;
export const POSTPARTUM_WEEKS_MAX = 78;

/** The columns this module reads off a `CycleProfile`. */
export interface PregnancyProfileFields {
  reproductiveState?: CycleReproductiveState | null;
  pregnancyStartDate?: string | null;
  pregnancyDueDate?: string | null;
  deliveryDate?: string | null;
  postpartumWeeks?: number | null;
}

/** The `CycleProfile` columns the state lives in, for a Prisma `select`. */
export const PREGNANCY_PROFILE_SELECT = {
  reproductiveState: true,
  pregnancyStartDate: true,
  pregnancyDueDate: true,
  deliveryDate: true,
  postpartumWeeks: true,
} as const;

/** The state's columns off a row that carries them. */
export function pregnancyFieldsOf(
  row: PregnancyProfileFields,
): PregnancyProfileFields {
  return {
    reproductiveState: row.reproductiveState ?? null,
    pregnancyStartDate: row.pregnancyStartDate ?? null,
    pregnancyDueDate: row.pregnancyDueDate ?? null,
    deliveryDate: row.deliveryDate ?? null,
    postpartumWeeks: row.postpartumWeeks ?? null,
  };
}

/** Completed weeks and days, "24+3". */
export interface GestationalAge {
  weeks: number;
  days: number;
}

/** The resolved state on one day. */
export interface ResolvedPregnancyState {
  /** What the owner set. */
  storedState: CycleReproductiveState | null;
  /** What holds on `today`: POSTPARTUM past its window resolves to null. */
  state: CycleReproductiveState | null;
  /** The first day used for the week count (given, or due date − 280). */
  effectiveStartDate: string | null;
  dueDate: string | null;
  deliveryDate: string | null;
  postpartumWeeks: number;
  /** PREGNANT only, when a start or due date is known. */
  gestationalAge: GestationalAge | null;
  /** POSTPARTUM only: completed weeks since the delivery. */
  postpartumWeek: number | null;
  /** POSTPARTUM only: the first day the ordinary cycle resumes. */
  postpartumEndsOn: string | null;
  /** The one predicate every forecast surface reads. */
  predictionsPaused: boolean;
}

function clampWeeks(weeks: number | null | undefined): number {
  if (typeof weeks !== "number" || !Number.isInteger(weeks)) {
    return POSTPARTUM_WEEKS_DEFAULT;
  }
  return Math.min(POSTPARTUM_WEEKS_MAX, Math.max(POSTPARTUM_WEEKS_MIN, weeks));
}

/** The first day the week count runs from, or null. */
export function pregnancyStartFor(
  profile: PregnancyProfileFields,
): string | null {
  if (profile.pregnancyStartDate) return profile.pregnancyStartDate;
  if (profile.pregnancyDueDate) {
    return addDays(profile.pregnancyDueDate, -PREGNANCY_TERM_DAYS);
  }
  return null;
}

/**
 * Completed weeks and days on `date` for a pregnancy that began on `start`.
 * Null before the start.
 */
export function gestationalAgeOn(
  start: string,
  date: string,
): GestationalAge | null {
  const elapsed = dayDiff(date, start);
  if (elapsed < 0) return null;
  return { weeks: Math.floor(elapsed / 7), days: elapsed % 7 };
}

/** The day the postpartum state ends (exclusive), or null without a delivery. */
export function postpartumEndFor(
  profile: PregnancyProfileFields,
): string | null {
  if (!profile.deliveryDate) return null;
  return addDays(profile.deliveryDate, clampWeeks(profile.postpartumWeeks) * 7);
}

/** Resolve the stored state on the owner's calendar day `today`. */
export function resolvePregnancyState(
  profile: PregnancyProfileFields,
  today: string,
): ResolvedPregnancyState {
  const storedState = profile.reproductiveState ?? null;
  const postpartumWeeks = clampWeeks(profile.postpartumWeeks);
  const effectiveStartDate = pregnancyStartFor(profile);
  const base: ResolvedPregnancyState = {
    storedState,
    state: null,
    effectiveStartDate,
    dueDate: profile.pregnancyDueDate ?? null,
    deliveryDate: profile.deliveryDate ?? null,
    postpartumWeeks,
    gestationalAge: null,
    postpartumWeek: null,
    postpartumEndsOn: null,
    predictionsPaused: false,
  };

  if (storedState === "PREGNANT") {
    return {
      ...base,
      state: "PREGNANT",
      gestationalAge: effectiveStartDate
        ? gestationalAgeOn(effectiveStartDate, today)
        : null,
      predictionsPaused: true,
    };
  }

  if (storedState === "POSTPARTUM" && profile.deliveryDate) {
    const endsOn = postpartumEndFor(profile);
    const elapsed = dayDiff(today, profile.deliveryDate);
    // A delivery date in the future is a typo, not a state that has not
    // begun: the owner said "postpartum", so it holds from today.
    const inWindow = endsOn === null || today < endsOn;
    if (inWindow) {
      return {
        ...base,
        state: "POSTPARTUM",
        postpartumWeek: Math.max(0, Math.floor(elapsed / 7)),
        postpartumEndsOn: endsOn,
        predictionsPaused: true,
      };
    }
    return { ...base, postpartumEndsOn: endsOn };
  }

  return base;
}

/** Shorthand for the one predicate. */
export function predictionsPausedOn(
  profile: PregnancyProfileFields,
  today: string,
): boolean {
  return resolvePregnancyState(profile, today).predictionsPaused;
}

/**
 * The stretches a timeline draws: the pregnancy (from its first day to the
 * delivery, or open while it is ongoing) and the postpartum window. Only what
 * the owner's dates place; a stretch without a known first day is not drawn.
 */
export function pregnancySpans(profile: PregnancyProfileFields): Array<{
  kind: "pregnancy" | "postpartum";
  start: string;
  end: string | null;
}> {
  const spans: Array<{
    kind: "pregnancy" | "postpartum";
    start: string;
    end: string | null;
  }> = [];
  const state = profile.reproductiveState ?? null;
  if (state === null) return spans;
  const start = pregnancyStartFor(profile);
  if (state === "PREGNANT") {
    if (start) spans.push({ kind: "pregnancy", start, end: null });
    return spans;
  }
  // POSTPARTUM
  if (!profile.deliveryDate) return spans;
  if (start && start <= profile.deliveryDate) {
    spans.push({ kind: "pregnancy", start, end: profile.deliveryDate });
  }
  const endsOn = postpartumEndFor(profile);
  spans.push({
    kind: "postpartum",
    start: profile.deliveryDate,
    end: endsOn ? addDays(endsOn, -1) : null,
  });
  return spans;
}
