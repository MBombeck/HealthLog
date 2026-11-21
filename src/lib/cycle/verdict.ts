/**
 * The resolved cycle verdict — day-of-cycle, the ring's phase segments, the
 * overdue judgement and its day count, and the days until the next predicted
 * period. Computed here, on the server, once.
 *
 * This used to live in web client code (`src/components/cycle/wheel-state.ts`)
 * and every client that wanted the same answer had to reproduce it, including
 * the fourteen-day grace window that decides when the day count stops being
 * an observed fact. Two copies of that rule means two answers about one
 * person's body, and the second copy is how a cycle ring ends up frozen. The
 * rule now exists once and the answer travels on the wire.
 *
 * Pure and deterministic: it reads the calendar grid the same request already
 * built, plus the profile's typical lengths and the (already goal-gated)
 * prediction fields. No database, no clock — `today` is resolved by the caller
 * from the user's own timezone, which is also why a client cannot compute this
 * correctly on its own.
 */
import { dayDiff } from "./day-math";
import type { CyclePhase } from "./types";

const PHASE_ORDER: CyclePhase[] = [
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
];

/** One arc of the ring: a phase and its share of the represented cycle. */
export interface CyclePhaseSpan {
  phase: CyclePhase;
  fraction: number;
}

/**
 * What the record supports saying about today.
 *
 * - `IN_CYCLE` — today sits inside a cycle whose day count is still an
 *   observed fact. `dayOfCycle`, `phase` and `cycleStartDate` are all set.
 * - `OVERDUE` — the open cycle has run past the profile's typical length by
 *   more than the grace window. `dayOfCycle` and `phase` are null on purpose
 *   (see the ceiling below); `overdueDays` carries how late it is.
 * - `INSUFFICIENT_DATA` — today carries no phase at all: no cycle has been
 *   logged, or today falls outside every known cycle window.
 */
export type CycleVerdictState = "IN_CYCLE" | "OVERDUE" | "INSUFFICIENT_DATA";

export interface CycleVerdict {
  state: CycleVerdictState;
  /** 1-based day of the current cycle. Null in OVERDUE and INSUFFICIENT_DATA. */
  dayOfCycle: number | null;
  /** Days the ring represents (observed run, or the idealized cycle). */
  cycleLength: number | null;
  /** Today's phase. Null in OVERDUE and INSUFFICIENT_DATA. */
  phase: CyclePhase | null;
  /** The ring's arcs, as fractions summing to ~1. Empty when there is nothing to draw. */
  spans: CyclePhaseSpan[];
  /**
   * First day of the current cycle (`YYYY-MM-DD`), or null when no cycle is
   * active. Still set while OVERDUE — the last logged period start remains a
   * fact even once the count stops. Scopes the BBT chart to the same cycle the
   * ring shows.
   */
  cycleStartDate: string | null;
  /**
   * How many days past the profile's typical cycle length the open cycle has
   * run. Set only in OVERDUE. Measured against the typical length, not against
   * typical + grace: a person asking how late they are means "later than my
   * usual cycle", and the grace window is our tolerance, not their calendar.
   */
  overdueDays: number | null;
  /**
   * Days from today to the predicted next period start. Null when there is no
   * prediction (raw-chart mode / prediction disabled) and null once that
   * predicted start is in the past — at that point there is no "until", and
   * `state` + `overdueDays` carry what is true instead.
   */
  daysUntilNext: number | null;
  /** The fertile window as already goal-gated upstream, plus whether today falls in it. */
  fertileWindow: {
    start: string | null;
    end: string | null;
    active: boolean;
  };
}

/**
 * The profile-derived canonical phase lengths used to draw an idealized ring
 * for a low-data tracker (see `idealizedSpans`). All optional — every field
 * falls back to the textbook default when the profile has not set it.
 */
export interface CycleProfileLengths {
  /** Typical full cycle length in days (default 28). */
  typicalCycleLength?: number | null;
  /** Typical period (menstrual) length in days (default 5). */
  typicalPeriodLength?: number | null;
  /** Typical luteal-phase length in days (default 14). */
  lutealPhaseLength?: number | null;
}

/** The calendar-grid fields the verdict reads. `CalendarDayDTO` satisfies it. */
export interface VerdictCalendarDay {
  date: string;
  phase: CyclePhase | null;
  isFertileWindow: boolean;
}

export interface ResolveCycleVerdictInput {
  /** The calendar grid for the rendered span, in any order. */
  days: readonly VerdictCalendarDay[];
  /** Today's `YYYY-MM-DD` in the USER's timezone, not the process's. */
  today: string;
  profile?: CycleProfileLengths;
  /** `prediction.nextPeriodStart`, or null when no prediction ran. */
  nextPeriodStart?: string | null;
  /** Already goal- and cold-start-gated fertile window bounds. */
  fertileWindowStart?: string | null;
  fertileWindowEnd?: string | null;
  /**
   * The latest LOGGED period start at or before today, or null when the record
   * holds none. Read straight off the cycle rows, never off the grid.
   *
   * The grid's phase labels are gated: the calendar suppresses the whole phase
   * band while the engine is still learning (fewer than three observed cycles),
   * because a population-framed phase word off one or two cycles is not earned.
   * The day count is not that kind of claim — it is the number of days since a
   * start the person entered themselves — but deriving it from the labelled run
   * meant the gate took both, and a record with three logged periods rendered an
   * empty ring under an offer to log a first period. This anchor keeps the count
   * and the honest overdue judgement available when the labels are withheld;
   * the phase stays null, which is the part the gate is actually about.
   */
  lastPeriodStart?: string | null;
}

/** Below this many labelled days in the current cycle run, the ring would
 * normalise a 1-3 day partial run so a single phase filled the whole circle.
 * For such low-data trackers we draw the canonical four-phase proportions from
 * the profile instead, so the dial always reads as a real cycle wheel. A run
 * of 7+ labelled days already spans more than the menstrual phase, so the
 * observed-share path takes over from there. */
const SPARSE_RUN_THRESHOLD = 7;

/**
 * Days PAST the profile's typical cycle length before the count stops.
 * The engine keeps the open cycle's phase window alive until the predicted
 * next start, and a confirmed/anchored ovulation signal (BBT trend,
 * symptothermal double-check, LH surge) or a long estimated length can push
 * that prediction into the future while the last logged period is months old —
 * every day of the gap then carries a (population-framed) LUTEAL label and the
 * day-of-cycle walks up without bound ("day 90"). Beyond typical + grace the
 * count is no longer an observed fact, so the verdict degrades to the honest
 * overdue state instead. Two weeks of grace covers ordinary cycle-to-cycle
 * variation without hiding a real delay.
 *
 * This constant is deliberately NOT published on the wire. A client that knows
 * the threshold will eventually apply it itself, and then there are two
 * deciders again. Clients read `state` and `overdueDays`.
 */
const OVERDUE_GRACE_DAYS = 14;

/** The profile's typical cycle length, floored at a week. */
function typicalCycleLength(profile?: CycleProfileLengths): number {
  return Math.max(Math.round(profile?.typicalCycleLength ?? 28) || 28, 7);
}

/**
 * The canonical four-phase span set for a low-data tracker, derived from the
 * profile's typical lengths (textbook defaults when unset): a 28-day cycle
 * with a 5-day period, a 2-day ovulatory window, a 14-day luteal phase, and
 * the follicular phase filling the remainder. Proportions, not day counts, so
 * the ring renders the familiar MENSTRUAL/FOLLICULAR/OVULATORY/LUTEAL arcs
 * instead of one dominant sliver.
 */
function idealizedSpans(profile?: CycleProfileLengths): {
  spans: CyclePhaseSpan[];
  cycleLength: number;
} {
  const cycle = typicalCycleLength(profile);
  const period = Math.min(
    Math.max(Math.round(profile?.typicalPeriodLength ?? 5) || 5, 1),
    cycle - 3,
  );
  const luteal = Math.min(
    Math.max(Math.round(profile?.lutealPhaseLength ?? 14) || 14, 1),
    cycle - period - 1,
  );
  // A short ovulatory window sits at the fertile peak; the follicular phase
  // fills whatever remains between the period and the ovulatory window.
  const ovulatory = Math.min(2, Math.max(cycle - period - luteal - 1, 1));
  const follicular = Math.max(cycle - period - ovulatory - luteal, 1);

  const days: Record<CyclePhase, number> = {
    MENSTRUAL: period,
    FOLLICULAR: follicular,
    OVULATORY: ovulatory,
    LUTEAL: luteal,
  };
  const total = days.MENSTRUAL + days.FOLLICULAR + days.OVULATORY + days.LUTEAL;
  const spans = PHASE_ORDER.map((phase) => ({
    phase,
    fraction: days[phase] / total,
  }));
  return { spans, cycleLength: total };
}

/**
 * Walk back from `todayIdx` to the start of the current MENSTRUAL-anchored run:
 * the first day of the most recent MENSTRUAL block at/before today with no phase
 * gap. Assumes `sorted[todayIdx].phase != null` (the caller checks first).
 */
function findCycleStartIndex(
  sorted: readonly VerdictCalendarDay[],
  todayIdx: number,
): number {
  let startIdx = todayIdx;
  for (let i = todayIdx; i >= 0; i--) {
    const d = sorted[i];
    if (d.phase == null) break;
    startIdx = i;
    if (
      d.phase === "MENSTRUAL" &&
      (i === 0 || sorted[i - 1].phase !== "MENSTRUAL")
    ) {
      break;
    }
  }
  return startIdx;
}

/** Days from today to the next predicted start, or null once it is past. */
function resolveDaysUntilNext(
  today: string,
  nextPeriodStart: string | null | undefined,
): number | null {
  if (!nextPeriodStart) return null;
  const delta = dayDiff(nextPeriodStart, today);
  return delta >= 0 ? delta : null;
}

function resolveFertileWindow(
  input: ResolveCycleVerdictInput,
  todayDay: VerdictCalendarDay | undefined,
): CycleVerdict["fertileWindow"] {
  return {
    start: input.fertileWindowStart ?? null,
    end: input.fertileWindowEnd ?? null,
    active: todayDay?.isFertileWindow ?? false,
  };
}

/**
 * The verdict for a record whose grid carries no phase for today but whose
 * cycle rows carry a logged period start: count from that start, and apply the
 * same overdue ceiling. No phase is claimed — that is exactly the claim the
 * missing labels were withholding. Null when no start precedes today, which is
 * the one case that really is INSUFFICIENT_DATA.
 */
function verdictFromLoggedStart(
  input: ResolveCycleVerdictInput,
  fertileWindow: CycleVerdict["fertileWindow"],
  daysUntilNext: number | null,
): CycleVerdict | null {
  const { today, profile, lastPeriodStart } = input;
  if (!lastPeriodStart) return null;
  const elapsed = dayDiff(today, lastPeriodStart);
  if (elapsed < 0) return null;

  const dayOfCycle = elapsed + 1;
  const typicalLength = typicalCycleLength(profile);
  const ideal = idealizedSpans(profile);
  const overdue = dayOfCycle > typicalLength + OVERDUE_GRACE_DAYS;

  return {
    state: overdue ? "OVERDUE" : "IN_CYCLE",
    dayOfCycle: overdue ? null : dayOfCycle,
    cycleLength: ideal.cycleLength,
    phase: null,
    spans: ideal.spans,
    cycleStartDate: lastPeriodStart,
    overdueDays: overdue ? dayOfCycle - typicalLength : null,
    daysUntilNext,
    fertileWindow,
  };
}

/**
 * The 1-based day of the logged cycle `date` falls in, or null when the record
 * cannot say.
 *
 * This is the per-date sibling of the verdict's `dayOfCycle`, and it answers
 * for the date asked about rather than for today. A date belongs to the latest
 * logged start at or before it. A cycle that has a successor is closed, so any
 * day inside it is a recorded fact. The open cycle runs through today and is
 * held to the same ceiling as the verdict: past the typical length plus the
 * grace window the count is the engine's open-ended window, not an observed
 * day. No count before the first logged start, and none after today.
 *
 * `starts` must be sorted ascending.
 */
export function resolveCycleDay(
  date: string,
  starts: readonly string[],
  today: string,
  profile?: CycleProfileLengths,
): number | null {
  if (dayDiff(date, today) > 0) return null;
  let idx = -1;
  for (let i = 0; i < starts.length; i++) {
    if (dayDiff(date, starts[i]) >= 0) idx = i;
    else break;
  }
  if (idx < 0) return null;
  const day = dayDiff(date, starts[idx]) + 1;
  const isOpenCycle = idx === starts.length - 1;
  if (isOpenCycle && day > typicalCycleLength(profile) + OVERDUE_GRACE_DAYS) {
    return null;
  }
  return day;
}

/**
 * Resolve everything a client needs to render the cycle ring and its caption.
 * The only place in the product that decides any of it.
 */
/**
 * The verdict while a pregnancy or postpartum state pauses the
 * forecast: nothing about today. No cycle day, no phase, no "late". The state
 * is `INSUFFICIENT_DATA` so a client that predates the pregnancy field shows
 * its quiet empty state rather than a late period; a current client reads the
 * `pregnancy` block beside the verdict.
 */
export function pausedCycleVerdict(): CycleVerdict {
  return {
    state: "INSUFFICIENT_DATA",
    dayOfCycle: null,
    cycleLength: null,
    phase: null,
    spans: [],
    cycleStartDate: null,
    overdueDays: null,
    daysUntilNext: null,
    fertileWindow: { start: null, end: null, active: false },
  };
}

export function resolveCycleVerdict(
  input: ResolveCycleVerdictInput,
): CycleVerdict {
  const { days, today, profile } = input;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const todayDay = byDate.get(today);
  const fertileWindow = resolveFertileWindow(input, todayDay);
  const daysUntilNext = resolveDaysUntilNext(today, input.nextPeriodStart);

  const nothingToSay: CycleVerdict = {
    state: "INSUFFICIENT_DATA",
    dayOfCycle: null,
    cycleLength: null,
    phase: null,
    spans: [],
    cycleStartDate: null,
    overdueDays: null,
    daysUntilNext,
    fertileWindow,
  };

  if (!todayDay || todayDay.phase == null) {
    return (
      verdictFromLoggedStart(input, fertileWindow, daysUntilNext) ??
      nothingToSay
    );
  }

  // Sort dates ascending and find today's index.
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const todayIdx = sorted.findIndex((d) => d.date === today);
  if (todayIdx < 0) {
    return (
      verdictFromLoggedStart(input, fertileWindow, daysUntilNext) ??
      nothingToSay
    );
  }

  const startIdx = findCycleStartIndex(sorted, todayIdx);

  // The day count comes from the logged start when the caller supplied one,
  // and only falls back to the length of the labelled run when it did not.
  // The run is bounded by the grid, so counting rows made the answer depend on
  // how much calendar the caller happened to ask for: the same day reads as
  // day 11 over a month and day 23 over three. That was latent while every
  // caller asked for the same ninety days, and stopped being latent when the
  // month grid started reading its own month. The arcs below stay grid-derived
  // — they are about what the ring can draw, not about what day it is.
  const anchoredStart =
    input.lastPeriodStart && dayDiff(today, input.lastPeriodStart) >= 0
      ? input.lastPeriodStart
      : sorted[startIdx].date;
  const cycleStartDate = anchoredStart;
  const dayOfCycle = dayDiff(today, anchoredStart) + 1;

  // Honest ceiling: once the run overshoots the typical length + grace, the
  // count reflects the engine's open-ended cycle window, not an observed
  // cycle day. Degrade to the idealized ring with no day / phase claim; the
  // caption says the period is late and by how much.
  const typicalLength = typicalCycleLength(profile);
  if (dayOfCycle > typicalLength + OVERDUE_GRACE_DAYS) {
    const ideal = idealizedSpans(profile);
    return {
      state: "OVERDUE",
      dayOfCycle: null,
      cycleLength: ideal.cycleLength,
      phase: null,
      spans: ideal.spans,
      cycleStartDate,
      overdueDays: dayOfCycle - typicalLength,
      daysUntilNext,
      fertileWindow,
    };
  }

  // Tally each phase's day-count across the run + the forward predicted run
  // (so the ring shows the whole cycle, not just elapsed days).
  const counts: Record<CyclePhase, number> = {
    MENSTRUAL: 0,
    FOLLICULAR: 0,
    OVULATORY: 0,
    LUTEAL: 0,
  };
  // Include forward days until the next MENSTRUAL block to bound a full cycle.
  let end = todayIdx;
  for (let i = todayIdx + 1; i < sorted.length; i++) {
    const d = sorted[i];
    if (d.phase == null) break;
    if (d.phase === "MENSTRUAL") break;
    end = i;
  }
  const fullRun = sorted.slice(startIdx, end + 1);
  for (const d of fullRun) {
    if (d.phase) counts[d.phase] += 1;
  }

  // Low-data tracker: too few labelled days to span a real cycle. The
  // observed-share math would normalise a 1-3 day partial run so a single
  // phase filled the whole ring (the "one dominant arc" bug). Fall back to the
  // canonical four-phase proportions derived from the profile's typical
  // lengths so the dial reads as a real cycle wheel. The current phase + the
  // day-of-cycle marker stay driven by the observed labels; only the arc
  // proportions and the ring's represented length come from the ideal.
  if (fullRun.length < SPARSE_RUN_THRESHOLD) {
    const ideal = idealizedSpans(profile);
    return {
      state: "IN_CYCLE",
      dayOfCycle,
      cycleLength: ideal.cycleLength,
      phase: todayDay.phase,
      spans: ideal.spans,
      cycleStartDate,
      overdueDays: null,
      daysUntilNext,
      fertileWindow,
    };
  }

  const total = fullRun.length || 1;
  const spans = PHASE_ORDER.filter((p) => counts[p] > 0).map((phase) => ({
    phase,
    fraction: counts[phase] / total,
  }));

  return {
    state: "IN_CYCLE",
    dayOfCycle,
    cycleLength: fullRun.length,
    phase: todayDay.phase,
    spans,
    cycleStartDate,
    overdueDays: null,
    daysUntilNext,
    fertileWindow,
  };
}
