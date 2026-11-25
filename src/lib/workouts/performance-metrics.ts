/**
 * The per-workout performance figures a watch computes for a session (#1343):
 * training effect, training load, recovery time, sweat loss, average power
 * and the running dynamics.
 *
 * They live in `Workout.metadata` under the fixed keys below, written by the
 * FIT import (`src/lib/fit/map.ts`). The Garmin integration wrote training
 * effect and load before this module existed, under its own keys; those are
 * read as a fallback so a workout synced from Garmin shows the same figures
 * without a rewrite of its row.
 *
 * `metadata` is JSON and never trusted by shape: every figure is read by
 * name through an own-property check, must be a finite number inside its
 * plausible range, and is dropped otherwise. A zero recovery time or sweat
 * loss is what a watch writes when it did not compute one, so the range of
 * those starts above zero.
 */

import { ownValue } from "@/lib/own-key";

/** A figure's metadata key, its Garmin fallback key, and its range. */
const FIGURES = {
  aerobicTrainingEffect: {
    fallback: "garminAerobicEffect",
    min: 0,
    max: 5,
  },
  anaerobicTrainingEffect: {
    fallback: "garminAnaerobicEffect",
    min: 0,
    max: 5,
  },
  trainingLoad: { fallback: "garminTrainingLoad", min: 0, max: 2000 },
  /** Minutes until the watch considers the person recovered. */
  recoveryTimeMin: { fallback: null, min: 1, max: 7 * 24 * 60 },
  /** Estimated sweat loss, millilitres. */
  sweatLossMl: { fallback: null, min: 1, max: 20_000 },
  avgPowerW: { fallback: null, min: 1, max: 3000 },
  /** Running dynamics: bounce per step, millimetres. */
  avgVerticalOscillationMm: { fallback: null, min: 1, max: 300 },
  /** Running dynamics: time a foot is on the ground per step, ms. */
  avgGroundContactTimeMs: { fallback: null, min: 1, max: 2000 },
  /** Running dynamics: the left foot's share of ground contact, percent. */
  avgGroundContactBalancePct: { fallback: null, min: 1, max: 99 },
} as const;

export type WorkoutPerformanceKey = keyof typeof FIGURES;

export const WORKOUT_PERFORMANCE_KEYS = Object.keys(
  FIGURES,
) as WorkoutPerformanceKey[];

export type WorkoutPerformance = Record<WorkoutPerformanceKey, number | null>;

function own(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return undefined;
  }
  return ownValue(obj as Record<string, unknown>, key);
}

/** The figure when it is a finite number inside its range, else null. */
export function plausibleFigure(
  key: WorkoutPerformanceKey,
  value: unknown,
): number | null {
  const { min, max } = FIGURES[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

/**
 * The workout's performance figures, or null when it carries none. A
 * figure under its own key wins over the Garmin fallback.
 */
export function readWorkoutPerformance(
  metadata: unknown,
): WorkoutPerformance | null {
  let any = false;
  const out = {} as WorkoutPerformance;
  for (const key of WORKOUT_PERFORMANCE_KEYS) {
    const { fallback } = FIGURES[key];
    const value =
      plausibleFigure(key, own(metadata, key)) ??
      (fallback ? plausibleFigure(key, own(metadata, fallback)) : null);
    out[key] = value;
    if (value !== null) any = true;
  }
  return any ? out : null;
}

/**
 * The figures `incoming` carries that `stored` does not show yet, keyed as
 * they are written, or null when there are none. Used to hand a file's
 * figures to a workout already stored from another source, without
 * overwriting anything that workout already says.
 */
export function missingPerformanceFigures(
  stored: unknown,
  incoming: unknown,
): Partial<Record<WorkoutPerformanceKey, number>> | null {
  const have = readWorkoutPerformance(stored);
  const add: Partial<Record<WorkoutPerformanceKey, number>> = {};
  let any = false;
  for (const key of WORKOUT_PERFORMANCE_KEYS) {
    if (have?.[key] != null) continue;
    const value = plausibleFigure(key, own(incoming, key));
    if (value === null) continue;
    add[key] = value;
    any = true;
  }
  return any ? add : null;
}
