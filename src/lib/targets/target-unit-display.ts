/**
 * v1.32.27 — the target/threshold subsystem's unit adapter.
 *
 * v1.32.26 wired the metric/imperial preference across every READING
 * surface but deliberately left target ranges canonical: a target panel
 * is a coupled display+edit unit, and converting only the display half
 * would corrupt the edit seed and the save round-trip. This module is
 * the missing half — one adapter that owns every direction of the
 * conversion so the three target surfaces (the Insights reference
 * panel, the per-metric edit sheet, the settings threshold editor)
 * cannot drift apart.
 *
 * Storage never changes. `User.thresholdsJson`, `METRIC_BOUNDS`, the
 * `/api/user/thresholds` wire contract, the effective-range resolver,
 * the doctor report, and the AI snapshot all stay canonical SI. The
 * adapter converts at the render boundary and inverts at the entry
 * boundary, exactly like `measurement-form.tsx` does for a raw reading.
 *
 * The four rules that make the round-trip safe:
 *
 *   1. `toDisplay` rounds to the transform's `decimals`, so the field
 *      shows "150" and not "150.00000000000003". Since v1.32.39 that
 *      rounding lives in `applyDisplayTransform` itself, so this adapter
 *      inherits it rather than re-applying it.
 *   2. `toCanonical` rounds the inverted value to 2 decimals — the same
 *      dialect the measurement entry form uses — so 150 lb persists as
 *      68.04 kg, not 68.03885550000001.
 *   3. Rules 1 + 2 compose back to the typed number: 150 lb → 68.04 kg
 *      → 150 lb. Save-then-reopen is stable.
 *   4. Guardrails round INWARD (min up, max down). A naive round of a
 *      30 kg floor gives 66.1 lb, which inverts to 29.98 kg and the
 *      server rejects it. Ceiling it to 66.2 lb inverts to 30.03 kg and
 *      passes.
 *
 * For a metric user every transformed type resolves to factor 1 /
 * offset 0, `rescales` is false, and all four helpers return their
 * argument untouched — no rounding, no re-derivation. A metric
 * account's stored thresholds are therefore bit-for-bit unchanged by
 * this release.
 */
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  applyDisplayTransformUnrounded,
  getDisplayTransform,
  hasDisplayTransform,
  invertDisplayTransform,
  transformRescales,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import {
  MGDL_PER_MMOL,
  convertGlucose,
  toCanonicalMgdl,
  type GlucoseUnit,
} from "@/lib/glucose";

/** Canonical decimals a converted threshold value persists with. */
const CANONICAL_DECIMALS = 2;

/** Numeric `step` for a step-counting target — whole hundreds, not 0.1. */
const STEP_COUNT_INPUT_STEP = 100;

/** Fallback input step for a metric with no registered transform. */
const DEFAULT_INPUT_STEP = 0.1;

export interface TargetUnitAdapter {
  /** Unit symbol every label, hint, and tooltip on the surface announces. */
  unit: string;
  /** `step` for a display-unit numeric input on this metric. */
  step: number;
  /**
   * True when the adapter actually rescales the number (the imperial
   * branch of a transformed type). False for a metric user and for
   * every untransformed metric, in which case every helper below is the
   * exact identity.
   */
  rescales: boolean;
  /** Canonical stored value → the number the surface renders. */
  toDisplay(canonical: number): number;
  /** Typed display number → the canonical value that gets persisted. */
  toCanonical(display: number): number;
  /**
   * Canonical DELTA / band width / spread → display. Factor only, never
   * the affine offset: a 1 °C spread is a 1.8 °F spread, not 33.8 °F.
   */
  toDisplayDelta(canonicalDelta: number): number;
  /**
   * Canonical guardrail pair → the display window a typed value is
   * validated against, rounded inward so the inverted value never falls
   * outside the canonical guardrail the server enforces.
   */
  bounds(canonical: { min: number; max: number }): {
    min: number;
    max: number;
  };
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function ceilTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.ceil(value * scale) / scale;
}

function floorTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale) / scale;
}

/** The pass-through adapter: canonical unit, no arithmetic at all. */
function identityAdapter(metric: string, unit: string): TargetUnitAdapter {
  return {
    unit,
    step:
      metric === "ACTIVITY_STEPS" ? STEP_COUNT_INPUT_STEP : DEFAULT_INPUT_STEP,
    rescales: false,
    toDisplay: (canonical) => canonical,
    toCanonical: (display) => display,
    toDisplayDelta: (canonicalDelta) => canonicalDelta,
    bounds: (canonical) => ({ min: canonical.min, max: canonical.max }),
  };
}

/**
 * The glucose thresholds (`BLOOD_GLUCOSE_FASTING` and its siblings) are
 * stored in mg/dL and read in the reader's glucose unit. The settings editor
 * used to take the identity path for them, so an mmol/L account was asked
 * for mg/dL figures under a label that said nothing, against 40–400 bounds
 * and a "default: 70–99" hint — while the insights sheet for the same
 * threshold already spoke mmol/L.
 *
 * mmol/L reads at one decimal; the canonical write rounds to whole mg/dL
 * (`toCanonicalMgdl`), the precision every glucose path stores. Guardrails
 * round inward exactly like the imperial branch: 40 mg/dL is 2.22 mmol/L,
 * shown as 2.3 so that the typed bound inverts to 41 mg/dL and passes.
 */
function glucoseAdapter(glucoseUnit: GlucoseUnit): TargetUnitAdapter {
  if (glucoseUnit === "mg/dL") return identityAdapter("BLOOD_GLUCOSE", "mg/dL");
  const toMmol = (mgdl: number) => mgdl / MGDL_PER_MMOL;
  return {
    unit: "mmol/L",
    step: 0.1,
    rescales: true,
    toDisplay: (canonical) => convertGlucose(canonical, "mmol/L"),
    toCanonical: (display) => toCanonicalMgdl(display, "mmol/L"),
    toDisplayDelta: (canonicalDelta) => roundTo(toMmol(canonicalDelta), 1),
    bounds: (canonical) => ({
      min: ceilTo(toMmol(canonical.min), 1),
      max: floorTo(toMmol(canonical.max), 1),
    }),
  };
}

/** True for a glucose threshold metric or target-card type. */
export function isGlucoseTargetMetric(metric: string): boolean {
  return metric === "BLOOD_GLUCOSE" || metric.startsWith("BLOOD_GLUCOSE_");
}

/**
 * Resolve the unit adapter for one threshold metric / target-card type.
 *
 * `metric` is the threshold-metric literal (`"WEIGHT"`,
 * `"BLOOD_PRESSURE_SYS"`, …); for the transformed set those literals are
 * the measurement-type literals the display-transform registry is keyed
 * on, so a metric participates exactly when it has a registered
 * transform. `canonicalUnit` is the unit the surface announced before
 * this release (`METRIC_BOUNDS[metric].unit` or the targets payload's
 * `unit`) and is what an untransformed metric keeps. `glucoseUnit` is
 * the reader's glucose preference; it decides the glucose thresholds and
 * nothing else.
 */
export function resolveTargetUnitAdapter(
  metric: string,
  canonicalUnit: string,
  preference: UnitPreference,
  glucoseUnit: GlucoseUnit,
): TargetUnitAdapter {
  if (isGlucoseTargetMetric(metric)) return glucoseAdapter(glucoseUnit);
  if (!hasDisplayTransform(metric))
    return identityAdapter(metric, canonicalUnit);

  const transform = getDisplayTransform(metric, preference);
  const rescales = transformRescales(transform);

  // A transformed type on the metric branch keeps the transform's
  // DISPLAY symbol (which is the canonical symbol for every threshold
  // metric in the registry today) but no arithmetic — the identity
  // adapter guarantees the stored value is untouched.
  if (!rescales) return identityAdapter(metric, transform.displayUnit);

  const { decimals } = transform;
  return {
    unit: transform.displayUnit,
    step: metric === "ACTIVITY_STEPS" ? STEP_COUNT_INPUT_STEP : 10 ** -decimals,
    rescales: true,
    // Both converters round to `decimals` inside the shared helper.
    toDisplay: (canonical) => applyDisplayTransform(canonical, transform),
    toCanonical: (display) =>
      roundTo(invertDisplayTransform(display, transform), CANONICAL_DECIMALS),
    toDisplayDelta: (canonicalDelta) =>
      applyDisplayTransformDelta(canonicalDelta, transform),
    // A guardrail is not a rendered value — it is the window a typed
    // number is checked against, and it has to round INWARD (rule 4).
    // That needs the UNROUNDED edge: the shared helper would round a 30 kg
    // floor to 66.1 lb first and the ceiling below would then be a no-op on an
    // edge that already inverts to 29.98 kg.
    bounds: (canonical) => ({
      min: ceilTo(
        applyDisplayTransformUnrounded(canonical.min, transform),
        decimals,
      ),
      max: floorTo(
        applyDisplayTransformUnrounded(canonical.max, transform),
        decimals,
      ),
    }),
  };
}
