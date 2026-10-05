/**
 * v1.25 — health-status / baseline-drift shaping.
 *
 * Surfaces what is drifting from the user's own normal by combining two
 * existing read-only engines:
 *   - the personal-band deviations from the coincident-deviation flag
 *     (`coincident-deviation.ts`, which fans `VITALS_BASELINE` across vitals),
 *     keeping only the vitals that sit OUTSIDE their band today, and
 *   - the dated, sustained level shifts from the changepoint detector
 *     (`changepoint.ts`).
 *
 * This module owns only the pure reshaping — taking the engine outputs and
 * folding them into the flat response the card reads — so the present / absent
 * states are unit-testable without Prisma. It never labels a cause and never
 * diagnoses; it lists what changed and frames it as awareness only.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { VitalDeviation } from "@/lib/insights/derived/coincident-deviation";
import type { ChangepointSignal } from "@/lib/insights/derived/changepoint";
import { isCurrentForTodayClaim } from "@/lib/insights/measurement-freshness";

/** One vital sitting outside its personal band today. */
export interface HealthStatusDeviation {
  type: MeasurementType;
  /** Today's value. */
  value: number;
  /** Band center (median). */
  center: number;
  low: number;
  high: number;
  /** Which side of the band the value falls on. */
  direction: "above" | "below";
  /**
   * What the band describes: the whole day (`day`), or the same hours of the
   * earlier days (`sameHours`), for a day still in progress whose mean moves
   * with the hour (glucose). A surface naming the range says which.
   */
  basis: "day" | "sameHours";
}

/** One dated, sustained level shift from the changepoint detector. */
export interface HealthStatusShift {
  metric: MeasurementType;
  /** YYYY-MM-DD of the first day of the new level. */
  breakDate: string;
  beforeMean: number;
  afterMean: number;
  direction: "up" | "down";
}

export interface HealthStatusSummary {
  /** True when there is at least one deviation or one shift to surface. */
  present: boolean;
  deviations: HealthStatusDeviation[];
  shifts: HealthStatusShift[];
}

/**
 * Fold the band deviations + level shifts into the response shape. `vitals` is
 * the full banded set from the coincident engine (any standing); only the
 * out-of-band ones become deviations. `shifts` is the changepoint output as-is.
 */
export function summariseHealthStatus(
  vitals: readonly VitalDeviation[],
  shifts: readonly ChangepointSignal[],
): HealthStatusSummary {
  const deviations: HealthStatusDeviation[] = vitals
    // Present tense, so present readings only. "Your pulse is above your usual
    // range" describes now; a reading from last week describes last week, and
    // the card carried no date to say which. A vital whose freshest reading is
    // outside the claim window is left out rather than dressed as current —
    // the changepoint shifts below are dated by construction and unaffected.
    .filter(
      (v) =>
        v.outside && v.direction !== "in" && isCurrentForTodayClaim(v.daysAgo),
    )
    .map((v) => ({
      type: v.type,
      value: v.value,
      center: v.center,
      low: v.low,
      high: v.high,
      direction: v.direction === "above" ? "above" : "below",
      basis: v.basis ?? "day",
    }));

  const mappedShifts: HealthStatusShift[] = shifts.map((s) => ({
    metric: s.metric,
    breakDate: s.breakDate,
    beforeMean: s.beforeMean,
    afterMean: s.afterMean,
    direction: s.direction,
  }));

  return {
    present: deviations.length + mappedShifts.length > 0,
    deviations,
    shifts: mappedShifts,
  };
}
