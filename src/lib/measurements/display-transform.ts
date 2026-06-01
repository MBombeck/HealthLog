/**
 * v1.7.0 — display-time unit transforms.
 *
 * Canonical storage stays SI (the iOS wire contract + the Withings
 * passthrough both lock raw SI — see the convention block in
 * `apple-health-mapping.ts`). A handful of metrics read better in a
 * derived unit at the display boundary only:
 *
 *   - WALKING_SPEED is stored in m/s but a casual gait of 1.3 m/s
 *     reads as "4.7 km/h" to a human.
 *   - WALKING_RUNNING_DISTANCE is stored in metres but a 5 km walk
 *     reads as "5000 m"; daily totals make more sense in km.
 *
 * The transform is applied at the render layer only (chart `valueScale`
 * + the measurement-list cell + tooltip). Raw rows, plausibility
 * ranges, rollup math, and the AI snapshot all keep canonical SI. A
 * `factor` of 1 is the identity transform and is what every other
 * type resolves to, so callers that pass an un-transformed value see
 * no change (charts stay visually identical).
 *
 * The metric/imperial user preference (`unitPreference`) selects which
 * branch a transform exposes. The default is metric; the imperial
 * branch is additive and only wired for the two distance/speed metrics
 * so far — every other type ignores the preference entirely.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { getUnitForType } from "@/lib/validations/measurement";

export type UnitPreference = "metric" | "imperial";

export const DEFAULT_UNIT_PREFERENCE: UnitPreference = "metric";

export interface DisplayTransform {
  /** Multiplier applied to the raw canonical value for display. */
  factor: number;
  /** Unit string shown next to the displayed value. */
  displayUnit: string;
  /** Decimal places for the displayed value. */
  decimals: number;
}

/** Identity transform — raw canonical value, canonical unit. */
const IDENTITY: DisplayTransform = {
  factor: 1,
  displayUnit: "",
  decimals: 1,
};

/**
 * Per-type, per-preference transforms. Only types that genuinely read
 * better in a derived unit appear here; everything else resolves to
 * the identity transform with the canonical unit from
 * `getUnitForType()`.
 *
 * Metric branch ships in v1.7.0. The imperial branch is additive: it
 * covers the same two metrics in mph / miles so the global
 * metric/imperial toggle has somewhere to land without a follow-up
 * migration.
 */
const TRANSFORMS: Partial<
  Record<MeasurementType, Record<UnitPreference, DisplayTransform>>
> = {
  // 1 m/s = 3.6 km/h = 2.236936 mph.
  WALKING_SPEED: {
    metric: { factor: 3.6, displayUnit: "km/h", decimals: 1 },
    imperial: { factor: 2.2369362920544, displayUnit: "mph", decimals: 1 },
  },
  // Daily totals — 1 m = 0.001 km = 0.000621371192 mi.
  WALKING_RUNNING_DISTANCE: {
    metric: { factor: 0.001, displayUnit: "km", decimals: 2 },
    imperial: { factor: 0.000621371192237, displayUnit: "mi", decimals: 2 },
  },
};

/**
 * Resolve the display transform for a `(type, preference)` pair.
 * Returns the identity transform (with the canonical unit) for every
 * type that has no registered transform, so call sites can apply the
 * result unconditionally.
 */
export function getDisplayTransform(
  type: string,
  preference: UnitPreference = DEFAULT_UNIT_PREFERENCE,
): DisplayTransform {
  const perType = TRANSFORMS[type as MeasurementType];
  if (!perType) {
    return { ...IDENTITY, displayUnit: getUnitForType(type) };
  }
  return perType[preference] ?? perType.metric;
}

/**
 * Apply a transform's factor to a raw canonical value. Pure helper —
 * keeps the multiply in one place so the chart, list cell, and tooltip
 * all scale identically.
 */
export function applyDisplayTransform(
  rawValue: number,
  transform: DisplayTransform,
): number {
  return rawValue * transform.factor;
}
