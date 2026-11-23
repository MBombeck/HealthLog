/**
 * Pregnancy and postpartum as a cycle state (v1.49).
 *
 * The owner sets the state on `CycleProfile`; this module resolves what it
 * means on a given day. It is pure: every caller passes the owner's own
 * calendar day, so the answer near midnight agrees with the calendar.
 *
 * The stored state is what holds now, and the dates bound it. A reader asks
 * about a day (today, the last day of a report's range), and the answer is
 * what held on THAT day:
 *
 *   - PREGNANT holds from the first day of the pregnancy, counted the usual
 *     way in completed weeks and days from `pregnancyStartDate`, or from the
 *     due date less 280 days when only the due date is known. Neither known:
 *     no week, the state holds. It holds until the owner changes it, but not
 *     past `PREGNANCY_OVERDUE_DAYS` after the due date (or after 280 days
 *     from the start without one): a state left standing after the birth is
 *     a stale entry, not a 60th week, and resolves to the ordinary cycle with
 *     `lapsed` set so the cycle page can ask.
 *   - POSTPARTUM holds from `deliveryDate` for `postpartumWeeks` weeks, then
 *     resolves to the ordinary cycle on its own. Before the delivery it was a
 *     pregnancy: from its first day, when one is known, the day resolves to
 *     PREGNANT with that day's week; before that, to nothing.
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

/**
 * How long after the due date a PREGNANT state still holds: four weeks, so
 * 44 weeks from the first day. Past it no pregnancy is still running, and
 * the state is read as an entry the owner forgot to change.
 */
export const PREGNANCY_OVERDUE_DAYS = 28;

/** Default length of the postpartum state, in weeks. */
export const POSTPARTUM_WEEKS_DEFAULT = 12;
export const POSTPARTUM_WEEKS_MIN = 1;
export const POSTPARTUM_WEEKS_MAX = 78;

/**
 * The state as this module reads it. Every field is required, so a stored
 * `CycleProfile` row (which keeps the state sealed, `pregnancy-store.ts`)
 * cannot be passed by mistake and read as "no state": open it with
 * `pregnancyFieldsOf` first.
 */
export interface PregnancyProfileFields {
  reproductiveState: CycleReproductiveState | null;
  pregnancyStartDate: string | null;
  pregnancyDueDate: string | null;
  deliveryDate: string | null;
  postpartumWeeks: number | null;
}

/**
 * The state off an input whose fields may be absent (the engine's
 * `CycleProfileInput`, where absent reads as the ordinary cycle).
 */
export function pregnancyFieldsFrom(
  input: Partial<PregnancyProfileFields>,
): PregnancyProfileFields {
  return {
    reproductiveState: input.reproductiveState ?? null,
    pregnancyStartDate: input.pregnancyStartDate ?? null,
    pregnancyDueDate: input.pregnancyDueDate ?? null,
    deliveryDate: input.deliveryDate ?? null,
    postpartumWeeks: input.postpartumWeeks ?? null,
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
  /**
   * PREGNANT is stored but its time is past (`PREGNANCY_OVERDUE_DAYS` after
   * the due date): the state no longer holds, and the owner may want to
   * change it.
   */
  lapsed: boolean;
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

/**
 * The first day a stored PREGNANT state no longer holds, or null when neither
 * a first day nor a due date is known.
 */
export function pregnancyLapsesOn(
  profile: PregnancyProfileFields,
): string | null {
  const start = pregnancyStartFor(profile);
  const due =
    profile.pregnancyDueDate ??
    (start ? addDays(start, PREGNANCY_TERM_DAYS) : null);
  return due ? addDays(due, PREGNANCY_OVERDUE_DAYS + 1) : null;
}

/** The day the postpartum state ends (exclusive), or null without a delivery. */
export function postpartumEndFor(
  profile: PregnancyProfileFields,
): string | null {
  if (!profile.deliveryDate) return null;
  return addDays(profile.deliveryDate, clampWeeks(profile.postpartumWeeks) * 7);
}

/**
 * Resolve the stored state on the owner's calendar day `day`: what held on
 * that day, bounded by the dates (see the module comment). Today for the
 * live surfaces, the last day of the range for a report.
 */
export function resolvePregnancyState(
  profile: PregnancyProfileFields,
  day: string,
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
    lapsed: false,
  };
  const pregnantOn = (): ResolvedPregnancyState => ({
    ...base,
    state: "PREGNANT",
    gestationalAge: effectiveStartDate
      ? gestationalAgeOn(effectiveStartDate, day)
      : null,
    predictionsPaused: true,
  });

  if (storedState === "PREGNANT") {
    if (effectiveStartDate && day < effectiveStartDate) return base;
    const lapsesOn = pregnancyLapsesOn(profile);
    if (lapsesOn && day >= lapsesOn) return { ...base, lapsed: true };
    return pregnantOn();
  }

  if (storedState === "POSTPARTUM" && profile.deliveryDate) {
    const endsOn = postpartumEndFor(profile);
    if (day < profile.deliveryDate) {
      return effectiveStartDate &&
        day >= effectiveStartDate &&
        effectiveStartDate <= profile.deliveryDate
        ? pregnantOn()
        : { ...base, postpartumEndsOn: endsOn };
    }
    if (endsOn === null || day < endsOn) {
      return {
        ...base,
        state: "POSTPARTUM",
        postpartumWeek: Math.floor(dayDiff(day, profile.deliveryDate) / 7),
        postpartumEndsOn: endsOn,
        predictionsPaused: true,
      };
    }
    return { ...base, postpartumEndsOn: endsOn };
  }

  return base;
}

/**
 * The state as it stood on the last day of `[from, to]` it held, for a
 * report over a range: the range's last day when the state held then, else
 * the last day of a stretch that ended inside the range. A range that ended
 * before the pregnancy began, or began after the postpartum window closed,
 * resolves to no state.
 */
export function resolvePregnancyStateDuring(
  profile: PregnancyProfileFields,
  from: string,
  to: string,
): ResolvedPregnancyState {
  const atEnd = resolvePregnancyState(profile, to);
  if (atEnd.state !== null) return atEnd;
  const lastHeld = pregnancySpans(profile)
    .filter((span) => span.start <= to && (span.end ?? to) >= from)
    .map((span) => (span.end !== null && span.end < to ? span.end : to))
    .sort()
    .pop();
  return lastHeld ? resolvePregnancyState(profile, lastHeld) : atEnd;
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
 * delivery, or to its last plausible day while it is stored as ongoing) and
 * the postpartum window. Only what
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
    const lapsesOn = pregnancyLapsesOn(profile);
    if (start) {
      spans.push({
        kind: "pregnancy",
        start,
        end: lapsesOn ? addDays(lapsesOn, -1) : null,
      });
    }
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
