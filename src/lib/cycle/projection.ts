/**
 * The forecast beyond the next period: a few cycles ahead, each with a band
 * that widens the further out it reaches (#1350).
 *
 * Pure and DB-free. It reads the engine's own result for the next cycle and
 * the same length statistics the engine computed it from, and adds nothing the
 * engine does not already know. Cycle 1 is the engine's forecast unchanged —
 * a confirmed ovulation, an LH anchor or a cold-start band bonus all still
 * apply to it — so every surface that shows "the next period" agrees with the
 * projection's first row by construction. TypeScript only: the Swift engine
 * mirrors algorithm.md §1–§5, and nothing here changes that output.
 *
 * The band of cycle k ≥ 2 is the robust SD of a sum of k cycle lengths whose
 * mean is itself estimated from n observed ones, `σ·√(k + k²/n)`, widened by
 * the same logging-sparsity penalty the engine applies to cycle 1. It never
 * narrows from one cycle to the next. The horizon stops itself where the band
 * passes ±10 days or half a cycle: beyond that a date is a guess, and the
 * honest answer is not to print one.
 */
import {
  adherenceFactors,
  completedLengths,
  estimateCycleLength,
} from "./prediction";
import { addDays, dayDiff } from "./day-math";
import type {
  CycleInput,
  CyclePredictionResult,
  CycleTrackingGoal,
  DayLogInput,
} from "./types";

/** The most cycles a projection ever reaches. */
export const PROJECTION_MAX_HORIZON = 6;

/** The widest band (± days) a projected cycle may carry and still be shown. */
export const PROJECTION_BAND_CAP_DAYS = 10;

/**
 * Why the projection holds what it holds.
 *
 *   `OK`       the projected cycles, self-capped.
 *   `LEARNING` fewer than three observed cycles: the next period only, or
 *              nothing when no cycle is logged at all.
 *   `LATE`     the next period's band has passed with no new period logged.
 *              No forecast until one is: a past-dated or re-anchored guess
 *              would be a claim the data does not support.
 *   `OFF`      prediction is switched off, or raw-chart mode is on.
 */
export type ProjectionState = "OK" | "LEARNING" | "LATE" | "OFF";

export interface ProjectedCycle {
  /** 1 = the next period; the engine's own forecast. */
  k: number;
  /** The most likely first day, `YYYY-MM-DD`. */
  start: string;
  /** Predicted bleeding days. */
  periodLength: number;
  /** The earliest likely first day (start − band). */
  bandStart: string;
  /** The latest likely first day (start + band). */
  bandEnd: string;
}

export interface CycleProjection {
  state: ProjectionState;
  cycles: ProjectedCycle[];
}

export interface ProjectionInput {
  /** The gated engine result (`gatedPrediction`), or null when gated off. */
  prediction: CyclePredictionResult | null;
  /** The record's cycles, any order. */
  cycles: readonly CycleInput[];
  /** The day logs the prediction was computed from. */
  dayLogs: readonly DayLogInput[];
  goal: CycleTrackingGoal;
  /** Today in the record's timezone. */
  today: string;
  /** How many cycles the caller wants, at most. Clamped to 1..6. */
  horizon: number;
}

function cycleOne(p: CyclePredictionResult): ProjectedCycle {
  return {
    k: 1,
    start: p.nextPeriodStart,
    periodLength: p.predictedPeriodLength,
    bandStart: p.nextPeriodStartLow,
    bandEnd: p.nextPeriodStartHigh,
  };
}

/**
 * Project the next `horizon` cycles. See the module comment for the rules;
 * the order of the early returns is the order the states are decided in.
 */
export function projectCycles(input: ProjectionInput): CycleProjection {
  const { prediction, today } = input;
  if (prediction === null) return { state: "OFF", cycles: [] };

  // No logged cycle at all: the engine would anchor a population prior on
  // today. That is not the record's forecast, so nothing is projected.
  if (input.cycles.length === 0) return { state: "LEARNING", cycles: [] };

  // The late rule. The band of the next period ended before today and no new
  // period was logged (a logged one would have moved the anchor). Deliberately
  // stricter than the verdict's OVERDUE, which waits for typical + 14 days:
  // a feed that kept printing a period in the past would be wrong every day.
  if (dayDiff(today, prediction.nextPeriodStartHigh) > 0) {
    return { state: "LATE", cycles: [] };
  }

  const first = cycleOne(prediction);
  if (prediction.stillLearning) return { state: "LEARNING", cycles: [first] };
  // Perimenopause makes cycle length the very thing that changes; a chain of
  // further dates would extrapolate exactly the regularity that has gone.
  if (input.goal === "PERIMENOPAUSE") return { state: "OK", cycles: [first] };

  const horizon = Math.max(
    1,
    Math.min(PROJECTION_MAX_HORIZON, Math.trunc(input.horizon)),
  );
  const est = estimateCycleLength(completedLengths(input.cycles), input.goal);
  const n = est.cyclesObserved;
  if (!Number.isFinite(est.lengthFractional) || n < 1) {
    return { state: "OK", cycles: [first] };
  }

  const lastStart =
    [...input.cycles]
      .map((c) => c.startDate)
      .sort((a, b) => dayDiff(a, b))
      .at(-1) ?? today;
  const { logSparsity } = adherenceFactors(
    lastStart,
    est.lengthFractional,
    input.dayLogs,
    today,
  );
  const cap = Math.min(PROJECTION_BAND_CAP_DAYS, est.lengthFractional / 2);

  const out: ProjectedCycle[] = [first];
  let previousBand = dayDiff(first.bandEnd, first.start);
  for (let k = 2; k <= horizon; k++) {
    const spread = est.sigma * (1 + logSparsity) * Math.sqrt(k + (k * k) / n);
    const band = Math.max(previousBand + 1, Math.round(spread));
    if (band > cap) break;
    // Rounded per cycle from the fractional length, anchored on cycle 1's
    // start, so six cycles out carry no accumulated rounding drift.
    const start = addDays(
      first.start,
      Math.round((k - 1) * est.lengthFractional),
    );
    out.push({
      k,
      start,
      periodLength: prediction.predictedPeriodLength,
      bandStart: addDays(start, -band),
      bandEnd: addDays(start, band),
    });
    previousBand = band;
  }
  return { state: "OK", cycles: out };
}
