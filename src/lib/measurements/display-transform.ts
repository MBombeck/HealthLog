/**
 * v1.7.0 — display-time unit transforms.
 *
 * Canonical storage stays SI (the iOS wire contract + the Withings
 * passthrough both lock raw SI — see the convention block in
 * `apple-health-mapping.ts`). Storage never changes; the metric/imperial
 * user preference (`unitPreference`) only selects which branch a
 * transform exposes at the render boundary.
 *
 * A handful of metrics also read better in a derived unit regardless of
 * preference:
 *
 *   - WALKING_SPEED is stored in m/s but a casual gait of 1.3 m/s
 *     reads as "4.7 km/h" to a human.
 *   - WALKING_RUNNING_DISTANCE is stored in metres but a 5 km walk
 *     reads as "5000 m"; daily totals make more sense in km.
 *
 * The transform is applied at the render layer only (chart `valueScale`
 * + the measurement-list cell + tooltip + entry form). Raw rows,
 * plausibility ranges, rollup math, FHIR/CSV export, the doctor report,
 * and the AI snapshot all keep canonical SI. For a metric user every
 * transform below is the identity on the number (factor 1, offset 0), so
 * the metric render is byte-identical to before — charts stay visually
 * identical. The imperial branch rescales; that is the intended
 * behaviour, not a regression.
 *
 * v1.32.26 — the registry now covers the full weight-class / length /
 * temperature set the display surfaces render, and the interface gained
 * an affine `offset` so °C→°F (a shift, not just a scale) can be
 * expressed. The offset applies to ABSOLUTE values only; deltas, slopes,
 * standard deviations, and band widths take the factor alone — use
 * `applyDisplayTransformDelta` for those.
 *
 * v1.32.39 — the conversion helpers ROUND to the transform's own
 * `decimals`. Every transform has always declared how many decimals its
 * unit is read at, but the number was handed to the render layer and
 * only one screen ever asked for it, so everywhere else the raw product
 * of a kilogram and 2.20462262185 went straight to the surface
 * ("185.18790000000001 lb"). Rounding at the conversion means a surface
 * gets a correctly-scaled number whether or not it remembers to ask, and
 * a new converted-value surface cannot reintroduce the class.
 *
 * Two boundaries are deliberately exempt:
 *
 *   - A transform that does NOT rescale (`factor === 1`, no offset) is
 *     the exact identity, never rounded. That covers every untransformed
 *     type and the whole metric branch of the mass / length /
 *     temperature registry, whose numbers are the stored values
 *     themselves — a stored 78.45 kg is not conversion noise and must
 *     keep rendering as 78.45. `transformRescales()` is the predicate.
 *   - `invertDisplayTransform` — the ENTRY boundary — stays at full
 *     precision. A value rounded on the way out and inverted on the way
 *     back would drift the stored canonical number; the entry surfaces
 *     quantise the inverted value to their own canonical dialect.
 *
 * `applyDisplayTransformUnrounded` is the single documented escape
 * hatch, for arithmetic whose result is NOT rendered (the target
 * adapter's inward-rounded guardrails, which need the unrounded edge to
 * round the right way). Its call sites are frozen by
 * `src/__tests__/display-transform-rounding-guard.test.ts`.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import {
  MGDL_PER_MMOL,
  resolveGlucoseUnit,
  type GlucoseUnit,
} from "@/lib/glucose";
import { getUnitForType } from "@/lib/measurements/unit-map";

export type UnitPreference = "metric" | "imperial";

export const DEFAULT_UNIT_PREFERENCE: UnitPreference = "metric";

/** The stored preference column resolved to a branch; anything unknown is metric. */
export function resolveUnitPreference(
  raw: string | null | undefined,
): UnitPreference {
  return raw === "imperial" ? "imperial" : DEFAULT_UNIT_PREFERENCE;
}

/**
 * Both unit choices a person makes, together. They are separate columns
 * because they are separate questions — metric versus imperial is about mass,
 * length and temperature, mg/dL versus mmol/L is the clinical convention of
 * the country the record lives in — but a surface that renders a reading
 * needs both, and taking them as one value is what keeps a server-side text
 * producer from honouring one and forgetting the other.
 */
export interface UnitPreferences {
  system: UnitPreference;
  glucoseUnit: GlucoseUnit;
}

/** Resolve both stored columns at once (each falls back to its default). */
export function resolveUnitPreferences(row: {
  unitPreference?: string | null;
  glucoseUnit?: string | null;
}): UnitPreferences {
  return {
    system: resolveUnitPreference(row.unitPreference),
    glucoseUnit: resolveGlucoseUnit(row.glucoseUnit),
  };
}

/** The defaults: metric, mg/dL. */
export const DEFAULT_UNIT_PREFERENCES: UnitPreferences = {
  system: DEFAULT_UNIT_PREFERENCE,
  glucoseUnit: "mg/dL",
};

export interface DisplayTransform {
  /** Multiplier applied to the raw canonical value for display. */
  factor: number;
  /**
   * Additive shift applied AFTER the factor for an absolute display
   * value (`display = raw * factor + offset`). Defaults to 0. Present
   * only for affine conversions (°C→°F). Deltas/slopes/SD must NOT use
   * it — see `applyDisplayTransformDelta`.
   */
  offset?: number;
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

// kg → lb (exact: 1 lb = 0.45359237 kg → 1 kg = 2.20462262185 lb).
const KG_TO_LB = 2.20462262185;
// cm → in (exact: 1 in = 2.54 cm → 1 cm = 0.393700787402 in).
const CM_TO_IN = 0.393700787402;

/** Shared metric/imperial branch pair for a body-mass metric (kg ↔ lb). */
const MASS_TRANSFORM: Record<UnitPreference, DisplayTransform> = {
  metric: { factor: 1, displayUnit: "kg", decimals: 1 },
  imperial: { factor: KG_TO_LB, displayUnit: "lb", decimals: 1 },
};

/** Shared branch pair for an ABSOLUTE temperature (°C ↔ °F, affine). */
const TEMPERATURE_TRANSFORM: Record<UnitPreference, DisplayTransform> = {
  metric: { factor: 1, displayUnit: "°C", decimals: 1 },
  imperial: { factor: 1.8, offset: 32, displayUnit: "°F", decimals: 1 },
};

/**
 * Per-type, per-preference transforms. Types absent here resolve to the
 * identity transform with the canonical unit from `getUnitForType()`.
 *
 * The metric branch of every entry below is the identity on the number
 * (factor 1, no offset), differing from `getUnitForType` only in the
 * DISPLAY symbol it surfaces (e.g. "°C" for the stored "celsius"). The
 * imperial branch carries the real conversion.
 */
const TRANSFORMS: Partial<
  Record<MeasurementType, Record<UnitPreference, DisplayTransform>>
> = {
  // ── Body-mass metrics (kg canonical → lb imperial) ──
  WEIGHT: MASS_TRANSFORM,
  TOTAL_BODY_WATER: MASS_TRANSFORM,
  BONE_MASS: MASS_TRANSFORM,
  FAT_MASS: MASS_TRANSFORM,
  FAT_FREE_MASS: MASS_TRANSFORM,
  MUSCLE_MASS: MASS_TRANSFORM,
  LEAN_BODY_MASS: MASS_TRANSFORM,
  GRIP_STRENGTH: MASS_TRANSFORM,
  // ── Circumference (cm canonical → in imperial) ──
  WAIST_CIRCUMFERENCE: {
    metric: { factor: 1, displayUnit: "cm", decimals: 1 },
    imperial: { factor: CM_TO_IN, displayUnit: "in", decimals: 1 },
  },
  // ── Absolute temperatures (°C canonical → °F imperial, affine) ──
  BODY_TEMPERATURE: TEMPERATURE_TRANSFORM,
  SKIN_TEMPERATURE: TEMPERATURE_TRANSFORM,
  WRIST_TEMPERATURE: TEMPERATURE_TRANSFORM,
  // A signed baseline DEVIATION (Δ°C) — the °F imperial branch scales by
  // 1.8 but carries NO +32 offset. A one-degree-Celsius deviation is a
  // 1.8-degree-Fahrenheit deviation, not a 33.8 °F reading.
  BODY_TEMPERATURE_DEVIATION: {
    metric: { factor: 1, displayUnit: "°C", decimals: 1 },
    imperial: { factor: 1.8, displayUnit: "°F", decimals: 1 },
  },
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
 * Blood glucose, stored in mg/dL, read in either clinical unit. Keyed by the
 * glucose preference rather than metric/imperial. The mmol/L branch rounds to
 * one decimal through `applyDisplayTransform`, which is exactly what
 * `mgdlToMmol` does, so a server-side text and a screen built on
 * `convertGlucose` print the same figure.
 */
const GLUCOSE_TRANSFORM: Record<GlucoseUnit, DisplayTransform> = {
  "mg/dL": { factor: 1, displayUnit: "mg/dL", decimals: 0 },
  "mmol/L": { factor: 1 / MGDL_PER_MMOL, displayUnit: "mmol/L", decimals: 1 },
};

/**
 * The transform for a reading of `type` under BOTH unit preferences — the
 * one resolver a server-side text producer (a status note, a narrative, a
 * prompt) takes its numbers and unit symbols from.
 *
 * The client surfaces keep `getDisplayTransform` through `useUnitDisplay`
 * and convert glucose through `convertGlucose` at the few places that render
 * it; folding glucose into that path would convert it a second time on the
 * screens that already do. Text built on the server has no such history, so
 * it starts from the complete answer.
 */
export function getReadingTransform(
  type: string,
  preferences: UnitPreferences,
): DisplayTransform {
  if (type === "BLOOD_GLUCOSE")
    return GLUCOSE_TRANSFORM[preferences.glucoseUnit];
  return getDisplayTransform(type, preferences.system);
}

/**
 * Every measurement type whose displayed number or unit depends on a unit
 * preference: the metric/imperial set plus glucose. Text that quoted one of
 * these was written in a unit, and goes stale when the preference changes.
 */
export function isUnitSensitiveType(type: string): boolean {
  return type === "BLOOD_GLUCOSE" || TRANSFORMED_TYPES.has(type);
}

/**
 * Quantities that are not a stored measurement type but are read in a unit
 * system all the same: a workout's distance and its elevation gain, both
 * stored in metres. Same rules as the type registry — the metric distance
 * branch reads kilometres, which is a rescale, so it rounds; the metric
 * elevation branch is the identity.
 */
export type QuantityKind = "distance" | "elevation";

// 1 m = 3.28083989501 ft.
const M_TO_FT = 3.28083989501;

const QUANTITY_TRANSFORMS: Record<
  QuantityKind,
  Record<UnitPreference, DisplayTransform>
> = {
  distance: {
    metric: { factor: 0.001, displayUnit: "km", decimals: 2 },
    imperial: { factor: 0.000621371192237, displayUnit: "mi", decimals: 2 },
  },
  elevation: {
    metric: { factor: 1, displayUnit: "m", decimals: 1 },
    imperial: { factor: M_TO_FT, displayUnit: "ft", decimals: 1 },
  },
};

/** The transform for a metre-valued quantity under a metric/imperial preference. */
export function getQuantityTransform(
  kind: QuantityKind,
  preference: UnitPreference,
): DisplayTransform {
  return QUANTITY_TRANSFORMS[kind][preference];
}

/**
 * Seconds per displayed distance unit (per km, or per mile) from a duration
 * and a distance in metres. A pace is a rate in the inverse direction of a
 * distance, so it divides by the factor instead of multiplying.
 */
export function paceSecondsPerDistanceUnit(
  durationSec: number,
  meters: number,
  preference: UnitPreference,
): number {
  const { factor } = QUANTITY_TRANSFORMS.distance[preference];
  return durationSec / (meters * factor);
}

/**
 * Every type with a registered transform. The structural guard test uses
 * this set to assert no display surface hardcodes a unit string / scale
 * for a type that should route through the transform instead.
 */
export const TRANSFORMED_TYPES: ReadonlySet<string> = new Set(
  Object.keys(TRANSFORMS),
);

/** True when `type` has a per-preference transform (vs the identity path). */
export function hasDisplayTransform(type: string): boolean {
  return TRANSFORMED_TYPES.has(type);
}

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
 * v1.16.4 — count metrics are integers by definition; any fractional
 * part on a stored sample is source noise (HK chunk splitting, device
 * estimation), so the raw-value surfaces render them with 0 decimals
 * ("9.689 steps", never "9.688,595 steps"). Every other type keeps the
 * formatter's default precision (≤3 digits, trailing zeros dropped).
 */
const INTEGER_DISPLAY_TYPES: ReadonlySet<string> = new Set([
  "ACTIVITY_STEPS",
  "FLIGHTS_CLIMBED",
  "FALL_COUNT",
  // kcal + daylight minutes — whole units are the meaningful display
  // grain for these day-cumulative counts.
  "ACTIVE_ENERGY_BURNED",
  "TIME_IN_DAYLIGHT",
]);

/**
 * Display fraction digits for a RAW (untransformed) value of `type`.
 * `0` for integer count metrics, `undefined` (= formatter default)
 * otherwise — pass the result straight into `Formatters.number`.
 */
export function rawDisplayFractionDigits(type: string): number | undefined {
  return INTEGER_DISPLAY_TYPES.has(type) ? 0 : undefined;
}

/**
 * True when a transform actually rescales the number it is applied to
 * (as opposed to only relabelling the unit symbol). False for the
 * identity transform of an untransformed type and for the metric branch
 * of every mass / length / temperature entry, where the displayed number
 * IS the stored number.
 */
export function transformRescales(transform: DisplayTransform): boolean {
  return transform.factor !== 1 || (transform.offset ?? 0) !== 0;
}

/** Round to `decimals` fraction digits. Non-finite input passes through. */
function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * The raw affine arithmetic — `raw * factor + offset`, NO rounding.
 *
 * Escape hatch, not the default. Use it only where the result is a
 * computation input rather than something a surface renders: the target
 * adapter needs the unrounded pound edge of the 30 kg guardrail to round
 * it INWARD (rounding it to the nearest tenth first gives 66.1 lb, which
 * inverts to 29.98 kg and the server rejects it). Anything that reaches
 * a screen takes `applyDisplayTransform`. The call sites of this export
 * are frozen by the rounding guard test.
 */
export function applyDisplayTransformUnrounded(
  rawValue: number,
  transform: DisplayTransform,
): number {
  return rawValue * transform.factor + (transform.offset ?? 0);
}

/**
 * Apply a transform to a raw canonical ABSOLUTE value:
 * `display = round(raw * factor + offset, decimals)`. Pure helper —
 * keeps the arithmetic in one place so the chart, list cell, tooltip,
 * and entry form all scale identically, and rounds to the transform's
 * declared `decimals` so no surface can render a converted value at
 * more precision than its unit is read at.
 *
 * A transform that does not rescale returns the raw value untouched —
 * the metric branch stays byte-identical to storage.
 */
export function applyDisplayTransform(
  rawValue: number,
  transform: DisplayTransform,
): number {
  if (!transformRescales(transform)) return rawValue;
  return roundToDecimals(
    applyDisplayTransformUnrounded(rawValue, transform),
    transform.decimals,
  );
}

/**
 * Apply a transform to a DELTA / slope / standard-deviation / band-width
 * — factor only, NEVER the offset. A 1 °C change is a 1.8 °F change; it
 * must not pick up the +32 absolute-scale shift.
 *
 * Rounded to the same `decimals` as an absolute value: every consumer of
 * a converted delta in the tree renders it (the dashboard 7-day trend,
 * the cycle and mood crosstab rows, the target range bar), and a delta
 * shown at a finer grain than the readings it was computed from is the
 * same defect in a different place. Comparisons in the tree are made on
 * canonical values, never on a converted delta; a future one that needs
 * the unrounded difference takes `applyDisplayTransformUnrounded`.
 *
 * A factor of 1 returns the delta untouched (the offset is irrelevant to
 * a difference, so the metric branch is the exact identity here too).
 */
export function applyDisplayTransformDelta(
  deltaValue: number,
  transform: DisplayTransform,
): number {
  if (transform.factor === 1) return deltaValue;
  return roundToDecimals(deltaValue * transform.factor, transform.decimals);
}

/**
 * Invert an absolute display value back to the canonical stored value:
 * `raw = (display - offset) / factor`. Used at the entry boundary so an
 * imperial user's typed number persists in canonical SI.
 *
 * Deliberately NOT rounded — this is the write path. Rounding here would
 * quantise the stored canonical value to the display unit's grain and
 * drift it a little further on every save. The entry surfaces round the
 * result to their own canonical dialect (two decimals) instead.
 */
export function invertDisplayTransform(
  displayValue: number,
  transform: DisplayTransform,
): number {
  return (displayValue - (transform.offset ?? 0)) / transform.factor;
}
