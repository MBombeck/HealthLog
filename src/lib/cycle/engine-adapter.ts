/**
 * Prisma-row → engine-input adapters + calendar composition
 * (ios-contract §2.D). The engine itself (`predictCycle`, `phaseSeries`)
 * is pure + DB-free; this module bridges the persisted rows to the plain
 * input shapes and assembles the `CalendarDayDTO` grid the read returns.
 */
import {
  predictCycle,
  phaseForDay,
  addDays,
  dayDiff,
  isWithin,
  type CycleInput,
  type DayLogInput,
  type NightlyTempInput,
  type CycleProfileInput,
  type CyclePredictionResult,
  type CyclePhase,
  type PhaseCycle,
  resolveLuteal,
  clampLuteal,
  POPULATION_DEFAULT_CYCLE,
  PERIOD_MAX,
} from "@/lib/cycle";
import { resolveCycleDay } from "./verdict";
import type {
  CycleProfile,
  CycleDayLog,
  MenstrualCycle,
} from "@/generated/prisma/client";

export interface CalendarDayDTO {
  date: string;
  phase: CyclePhase | null;
  isPredictedPeriod: boolean;
  isFertileWindow: boolean;
  isPredictedOvulation: boolean;
  isPeriodLogged: boolean;
  /**
   * Whether a logged cycle opens on this day. The client uses it to say what a
   * delete would take: removing the day-log of a cycle start removes the start
   * too, and a confirm dialog that does not name that is asking about the
   * wrong thing.
   */
  isCycleStart: boolean;
  /**
   * The 1-based day of the logged cycle this date belongs to, or null before
   * the first logged start, after today, or past the point where an open
   * cycle's count stops being an observed fact (the verdict's ceiling). For
   * today it equals `verdict.dayOfCycle`. The log sheet labels a date with
   * this, never with today's count.
   */
  cycleDay: number | null;
  /**
   * Whether the one-tap period end can land on this date: it sits inside the
   * first `PERIOD_MAX` days of a logged cycle, which is where the end
   * boundary stamps `periodEndDate`. Resolved per date so a back-dated period
   * can be closed whatever phase today is in.
   */
  periodEndable: boolean;
  flow: string | null;
  hasSymptoms: boolean;
  confidence: number;
  /** Logged basal body temperature (°C), or null. Feeds the web BBT chart. */
  basalBodyTempC: number | null;
  /** Whether the day's BBT is marked disturbed (excluded from the engine). */
  temperatureExcluded: boolean;
  /** Logged ovulation-test result, or null. */
  ovulationTest: string | null;
  /** Logged cervical-mucus quality, or null. */
  cervicalMucus: string | null;
  /** Logged cervix signs (symptothermal secondary indicator), each or null. */
  cervixPosition: string | null;
  cervixFirmness: string | null;
  cervixOpening: string | null;
  /** Spotting / bleeding outside the period logged on this day. */
  intermenstrualBleeding: boolean;
  /**
   * Intercourse logged on this day. Read through the same resolver as the
   * day-log itself (plaintext column or the encrypted envelope), and carried
   * under the same `cycle` grant: a caller who may read this grid may read
   * the day log it summarises, and one who may not reaches neither.
   */
  sexualActivity: boolean;
  /** Logged at-home pregnancy test result, or null. */
  pregnancyTest: string | null;
  /** Logged at-home progesterone test result, or null. */
  progesteroneTest: string | null;
  /** Logged contraceptive method, or null. */
  contraceptive: string | null;
  /** Whether the day carries a note. The note's text never rides the grid. */
  hasNote: boolean;
}

/** Rows the calendar needs from each day-log. */
export type CalendarDayLogRow = Pick<
  CycleDayLog,
  | "date"
  | "flow"
  | "basalBodyTempC"
  | "temperatureExcluded"
  | "ovulationTest"
  | "cervicalMucus"
  | "cervixPosition"
  | "cervixFirmness"
  | "cervixOpening"
  | "intermenstrualBleeding"
> & {
  hasSymptoms: boolean;
  hasNote: boolean;
  sexualActivity: boolean;
  pregnancyTest: string | null;
  progesteroneTest: string | null;
  contraceptive: string | null;
};

/** Map MenstrualCycle rows (oldest→newest) to engine `CycleInput`. */
export function toCycleInputs(
  cycles: readonly Pick<
    MenstrualCycle,
    | "startDate"
    | "endDate"
    | "periodEndDate"
    | "ovulationDate"
    | "ovulationConfirmed"
  >[],
): CycleInput[] {
  return cycles.map((c) => ({
    startDate: c.startDate,
    endDate: c.endDate,
    periodEndDate: c.periodEndDate,
    ovulationDate: c.ovulationDate,
    ovulationConfirmed: c.ovulationConfirmed,
  }));
}

/** Map CycleDayLog rows to engine `DayLogInput`. */
export function toDayLogInputs(
  logs: readonly Pick<
    CycleDayLog,
    | "date"
    | "flow"
    | "basalBodyTempC"
    | "temperatureExcluded"
    | "ovulationTest"
    | "cervicalMucus"
    | "cervixPosition"
    | "cervixFirmness"
    | "cervixOpening"
  >[],
): DayLogInput[] {
  return logs.map((l) => ({
    date: l.date,
    flow: l.flow,
    basalBodyTempC: l.basalBodyTempC,
    temperatureExcluded: l.temperatureExcluded,
    ovulationTest: l.ovulationTest,
    cervicalMucus: l.cervicalMucus,
    cervixPosition: l.cervixPosition,
    cervixFirmness: l.cervixFirmness,
    cervixOpening: l.cervixOpening,
  }));
}

/** Map a CycleProfile row to the engine's `CycleProfileInput`. */
export function toProfileInput(profile: CycleProfile): CycleProfileInput {
  return {
    goal: profile.goal,
    typicalCycleLength: profile.typicalCycleLength,
    typicalPeriodLength: profile.typicalPeriodLength,
    lutealPhaseLength: profile.lutealPhaseLength,
    predictionEnabled: profile.predictionEnabled,
    rawChartMode: profile.rawChartMode,
    secondarySymptom: profile.secondarySymptom,
  };
}

/** Period-length of an observed cycle: periodEnd − start + 1, or default. */
function periodLengthOf(
  cycle: Pick<MenstrualCycle, "startDate" | "periodEndDate">,
): number | null {
  if (!cycle.periodEndDate) return null;
  return dayDiff(cycle.periodEndDate, cycle.startDate) + 1;
}

/**
 * Build a contiguous `PhaseCycle[]` from the observed cycles: each closed
 * cycle's span ends where the next begins, and the latest open cycle runs to
 * the predicted next-period start — or, when that day has come and gone with
 * no period logged, on through `today`.
 *
 * That trailing extension is the difference between a late period and no
 * record at all. A cycle stays open until the next one starts, and a forecast
 * is a forecast: the day after a missed prediction is still a day of the cycle
 * the person is in. Ending the span at the predicted start instead made every
 * day past it carry no phase, which the verdict resolver could only read as
 * "today falls outside every known cycle window" — so an ordinary three-days-
 * late period reported INSUFFICIENT_DATA, and the honest OVERDUE state was
 * unreachable unless the engine itself forecast a cycle longer than the grace
 * window. The count is bounded on the other side: `resolveCycleVerdict` stops
 * claiming a cycle day once the run passes the profile's typical length plus
 * its grace window.
 *
 * The extension deliberately does NOT move the ovulation estimate. Left to
 * `phaseForDay`, an ovulation with no confirmed date is back-calculated from
 * the span's own length, so a window that grows a day per day of delay would
 * walk the estimate — and every FOLLICULAR/OVULATORY/LUTEAL boundary already
 * drawn for that cycle — forward with it. The open cycle therefore carries an
 * explicit anchor derived from the PREDICTED length, which is the same date
 * `phaseForDay` computes when the span ends where the forecast said it would.
 */
export function buildPhaseCycles(
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate"
  >[],
  predictedNextStart: string | null,
  lutealLength: number,
  /** Today in the USER's timezone. The open cycle runs at least this far. */
  today: string,
): PhaseCycle[] {
  const sorted = [...cycles].sort((a, b) => dayDiff(a.startDate, b.startDate));
  const out: PhaseCycle[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const next = sorted[i + 1];
    if (next) {
      out.push({
        startDate: c.startDate,
        nextStart: next.startDate,
        ovulationDate: c.ovulationDate,
        periodLength: periodLengthOf(c),
        lutealLength,
      });
      continue;
    }

    // The open cycle. `phaseForDay` treats `nextStart` as exclusive, so the
    // window has to reach the day AFTER today for today to carry a phase.
    const forecastEnd =
      predictedNextStart ?? addDays(c.startDate, POPULATION_DEFAULT_CYCLE);
    const throughToday = addDays(today, 1);
    const nextStart =
      dayDiff(throughToday, forecastEnd) > 0 ? throughToday : forecastEnd;
    out.push({
      startDate: c.startDate,
      nextStart,
      ovulationDate:
        c.ovulationDate ?? addDays(forecastEnd, -clampLuteal(lutealLength)),
      periodLength: periodLengthOf(c),
      lutealLength,
    });
  }
  return out;
}

/** Phase of a single date across the contiguous cycle list (or null). */
export function phaseAcross(
  date: string,
  phaseCycles: readonly PhaseCycle[],
): CyclePhase | null {
  for (const pc of phaseCycles) {
    const r = phaseForDay(date, pc);
    if (r.phase !== null) return r.phase;
  }
  return null;
}

/**
 * Resolve the phase + 1-based day-of-cycle of a single `YYYY-MM-DD` date
 * across the observed cycles, with the latest open cycle running to
 * `predictedNextStart` (or +28d). Returns `{ phase: null, dayOfCycle: null }`
 * when the date falls outside every cycle window. Used by the Coach snapshot
 * to state "you are on day N, luteal phase".
 */
export function phaseForDate(
  date: string,
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate"
  >[],
  predictedNextStart: string | null,
  lutealLength: number,
  /** Today in the USER's timezone — how far a still-open cycle runs. */
  today: string,
): { phase: CyclePhase | null; dayOfCycle: number | null } {
  const phaseCycles = buildPhaseCycles(
    cycles,
    predictedNextStart,
    lutealLength,
    today,
  );
  for (const pc of phaseCycles) {
    const r = phaseForDay(date, pc);
    if (r.phase !== null) return r;
  }
  return { phase: null, dayOfCycle: null };
}

/**
 * Build a `YYYY-MM-DD → CyclePhase` map across `[from, to]` inclusive from the
 * observed cycles. Days that fall outside every cycle window are omitted (no
 * key) rather than carrying a null — a consumer joins on presence. The latest
 * open cycle runs to `predictedNextStart` (or +28d) like `buildCalendar`, so
 * the trailing window is labelled even before the next period is logged.
 *
 * This is the per-day phase series the CYCLE_PHASE correlation channel and the
 * Coach phase block both consume, derived identically to the calendar grid so
 * the phase a day shows in the UI matches the phase the stats engine uses.
 */
export function buildPhaseDayMap(
  cycles: readonly Pick<
    MenstrualCycle,
    "startDate" | "endDate" | "periodEndDate" | "ovulationDate"
  >[],
  predictedNextStart: string | null,
  lutealLength: number,
  from: string,
  to: string,
  /** Today in the USER's timezone — how far a still-open cycle runs. */
  today: string,
): Map<string, CyclePhase> {
  const phaseCycles = buildPhaseCycles(
    cycles,
    predictedNextStart,
    lutealLength,
    today,
  );
  const out = new Map<string, CyclePhase>();
  const span = dayDiff(to, from);
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const phase = phaseAcross(date, phaseCycles);
    if (phase !== null) out.set(date, phase);
  }
  return out;
}

export interface CalendarBuildResult {
  prediction: CyclePredictionResult | null;
  /**
   * True while the engine is "still learning" the user's cycle (< 3 observed
   * cycles, mirrors `prediction.stillLearning`). When set, the calendar grid
   * does NOT assert a fertile window, an ovulation dot, or a population-framed
   * phase band — those are population guesses the app has not yet earned the
   * confidence to show as fact. The client renders a calm "learning your cycle"
   * state instead. False when no prediction ran (raw-chart mode / disabled).
   */
  stillLearning: boolean;
  days: CalendarDayDTO[];
}

/**
 * Compose the calendar grid for `[from, to]` inclusive. Runs the engine
 * once for the forward forecast, then labels each day's phase, predicted
 * period bar, fertile window, and logged-flow overlay.
 *
 * Fertile-window fields are caller-gated: pass `goalAllowsFertile=false`
 * (GENERAL_HEALTH / PERIMENOPAUSE) to suppress `isFertileWindow` +
 * `isPredictedOvulation` at the grid level (the prediction's own window
 * fields are nulled upstream by the engine for those goals).
 *
 * Cold-start honesty (C1): while the engine reports `stillLearning` (< 3
 * observed cycles), the grid suppresses the fertile window, the predicted-
 * ovulation dot, AND the phase band — all of which would otherwise be painted
 * from a population 28/14 prior at ~0.20 confidence. The predicted-period bar
 * is kept (the predictions panel shows it too while learning). This matches
 * the `stillLearning` gate the predictions panel already applies, so the
 * calendar grid never asserts "these are your fertile days" off a single
 * logged cycle.
 */
export function buildCalendar(
  profile: CycleProfile,
  cycles: readonly MenstrualCycle[],
  dayLogs: readonly CalendarDayLogRow[],
  nights: readonly NightlyTempInput[],
  from: string,
  to: string,
  today: string,
  goalAllowsFertile: boolean,
): CalendarBuildResult {
  // Clamp identically to the engine's resolveLuteal so the predicted-ovulation
  // dot (engine-clamped) and the OVULATORY phase band (this value) never
  // diverge for an out-of-clamp stored luteal length (QA HIGH).
  const lutealLength = resolveLuteal(profile);

  // Forecast (only when prediction is on + not raw-chart mode).
  let prediction: CyclePredictionResult | null = null;
  if (profile.predictionEnabled && !profile.rawChartMode) {
    prediction = predictCycle(
      toCycleInputs(cycles),
      toDayLogInputs(dayLogs),
      toProfileInput(profile),
      today,
      nights,
    );
  }

  // Cold-start gate: until ≥3 cycles are observed the engine's fertile/
  // ovulation/phase output rests on a population prior, so the calendar must
  // present it as a calm "learning" state rather than asserting it as fact.
  const stillLearning = prediction?.stillLearning ?? false;

  const phaseCycles = buildPhaseCycles(
    cycles,
    prediction?.nextPeriodStart ?? null,
    lutealLength,
    today,
  );

  // Forward predicted period bar: [nextPeriodStart, +predictedPeriodLength).
  const predictedPeriodStart = prediction?.nextPeriodStart ?? null;
  const predictedPeriodEnd =
    prediction && predictedPeriodStart
      ? addDays(
          predictedPeriodStart,
          Math.max(0, prediction.predictedPeriodLength - 1),
        )
      : null;

  const logByDate = new Map<string, CalendarDayLogRow>();
  for (const l of dayLogs) logByDate.set(l.date, l);

  const cycleStartDates = new Set(cycles.map((c) => c.startDate));
  const sortedStarts = [...cycleStartDates].sort((a, b) => dayDiff(a, b));
  const profileLengths = {
    typicalCycleLength: profile.typicalCycleLength,
    typicalPeriodLength: profile.typicalPeriodLength,
    lutealPhaseLength: profile.lutealPhaseLength,
  };

  const days: CalendarDayDTO[] = [];
  const span = dayDiff(to, from);
  for (let i = 0; i <= span; i++) {
    const date = addDays(from, i);
    const log = logByDate.get(date);

    const isPredictedPeriod =
      predictedPeriodStart !== null &&
      predictedPeriodEnd !== null &&
      isWithin(date, predictedPeriodStart, predictedPeriodEnd);

    const isFertileWindow =
      !stillLearning &&
      goalAllowsFertile &&
      prediction?.fertileWindowStart != null &&
      prediction.fertileWindowEnd != null &&
      isWithin(
        date,
        prediction.fertileWindowStart,
        prediction.fertileWindowEnd,
      );

    const isPredictedOvulation =
      !stillLearning &&
      goalAllowsFertile &&
      prediction?.predictedOvulation != null &&
      prediction.predictedOvulation === date;

    const cycleDay = resolveCycleDay(date, sortedStarts, today, profileLengths);

    days.push({
      date,
      // No asserted phase band while learning — a population-28 frame off a
      // single cycle is not yet earned (Lower: single-cycle phase band).
      phase: stillLearning ? null : phaseAcross(date, phaseCycles),
      isPredictedPeriod,
      isFertileWindow,
      isPredictedOvulation,
      isPeriodLogged: log?.flow != null && log.flow !== "NONE",
      isCycleStart: cycleStartDates.has(date),
      cycleDay,
      periodEndable: cycleDay !== null && cycleDay <= PERIOD_MAX,
      flow: log?.flow ?? null,
      hasSymptoms: log?.hasSymptoms ?? false,
      confidence: prediction?.confidence ?? 0,
      basalBodyTempC: log?.basalBodyTempC ?? null,
      temperatureExcluded: log?.temperatureExcluded ?? false,
      ovulationTest: log?.ovulationTest ?? null,
      cervicalMucus: log?.cervicalMucus ?? null,
      cervixPosition: log?.cervixPosition ?? null,
      cervixFirmness: log?.cervixFirmness ?? null,
      cervixOpening: log?.cervixOpening ?? null,
      intermenstrualBleeding: log?.intermenstrualBleeding ?? false,
      sexualActivity: log?.sexualActivity ?? false,
      pregnancyTest: log?.pregnancyTest ?? null,
      progesteroneTest: log?.progesteroneTest ?? null,
      contraceptive: log?.contraceptive ?? null,
      hasNote: log?.hasNote ?? false,
    });
  }

  return { prediction, stillLearning, days };
}
