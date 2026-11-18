/**
 * The medication Effect tab in the account's unit (#1406).
 *
 * The efficacy builder reads canonical stored values; a reader sees them in
 * the unit the rest of the app shows. Everything here turns one into the
 * other: the per-target display (unit symbol + absolute / delta conversion
 * through `getReadingTransform`), the reference band (the account's own
 * target where it has one) and the segmented estimates.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  getEffectiveRange,
  type ThresholdMetric,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { GLUCOSE_CONTEXT_UNSPECIFIED } from "@/lib/glucose";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  isUnitSensitiveType,
  resolveUnitPreferences,
  transformRescales,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import type {
  EfficacyEstimate,
  EfficacySegmented,
} from "@/lib/medications/efficacy/segmented-effect";
import { resolveGlucoseTarget } from "@/lib/targets/glucose-targets";

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * How a metric target's canonical numbers become the numbers the account
 * reads (#1406). `abs` converts an absolute value (series point, mean, band
 * edge), `delta` a difference (factor only, never an offset). Both round to
 * the transform's own grain when it rescales; an identity transform keeps the
 * one-decimal rounding the view always had.
 */
export interface EfficacyDisplay {
  unit: string | null;
  abs: (n: number) => number;
  delta: (n: number) => number;
  rescales: boolean;
}

export const CANONICAL_DISPLAY: EfficacyDisplay = {
  unit: null,
  abs: round1,
  delta: round1,
  rescales: false,
};

/**
 * The display for one metric target under the account's unit preferences.
 * Every unit-sensitive type (glucose, mass, length, temperature, …) takes its
 * unit symbol and conversion from `getReadingTransform`, the same resolver the
 * server-side text producers use; any other type keeps its registry unit.
 */
export function efficacyDisplayFor(
  mt: MeasurementType,
  registryUnit: string | null,
  preferences: UnitPreferences,
): EfficacyDisplay {
  if (!isUnitSensitiveType(mt)) {
    return { ...CANONICAL_DISPLAY, unit: registryUnit };
  }
  const transform = getReadingTransform(mt, preferences);
  if (!transformRescales(transform)) {
    return { ...CANONICAL_DISPLAY, unit: transform.displayUnit };
  }
  return {
    unit: transform.displayUnit,
    abs: (n) => applyDisplayTransform(n, transform),
    delta: (n) => applyDisplayTransformDelta(n, transform),
    rescales: true,
  };
}

/** The account columns the efficacy view reads its units and bands from. */
export interface EfficacyAccount {
  preferences: UnitPreferences;
  hasDiabetes: boolean;
  thresholds: ThresholdOverridesJson | null;
  profile: {
    heightCm: number | null;
    dateOfBirth: Date | null;
    gender: string | null;
  };
}

/** Threshold metrics whose name IS the measurement type they judge. */
const SAME_NAME_THRESHOLD_METRICS: ReadonlySet<string> =
  new Set<ThresholdMetric>([
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "ACTIVITY_STEPS",
    "TOTAL_BODY_WATER",
    "BONE_MASS",
    "OXYGEN_SATURATION",
  ]);

/**
 * The reference band for a metric target, canonical units. Blood glucose is
 * judged by the same resolver the targets page uses (`resolveGlucoseTarget`):
 * the day mean mixes meal contexts, so it takes the untagged bucket, which
 * honours the account's own threshold, its diabetes goal, and otherwise the
 * general 70–140 band. Any other metric takes the account's own target when
 * one is set, else the registry default.
 */
export function efficacyReferenceBand(
  mt: MeasurementType,
  registryBand: { low: number; high: number } | null,
  account: EfficacyAccount,
): { low: number; high: number } | null {
  if (mt === "BLOOD_GLUCOSE") {
    const { range } = resolveGlucoseTarget({
      context: GLUCOSE_CONTEXT_UNSPECIFIED,
      hasDiabetes: account.hasDiabetes,
      profile: account.profile,
      overrides: account.thresholds,
    });
    return range ? { low: range.greenMin, high: range.greenMax } : registryBand;
  }
  if (SAME_NAME_THRESHOLD_METRICS.has(mt)) {
    const eff = getEffectiveRange(
      mt as ThresholdMetric,
      account.profile,
      account.thresholds,
    );
    if (eff.isOverride && eff.range) {
      return { low: eff.range.greenMin, high: eff.range.greenMax };
    }
  }
  return registryBand;
}

/** Convert a segmented estimate's numbers (all differences) to the display unit. */
function displayEstimate(
  e: EfficacyEstimate | null,
  display: EfficacyDisplay,
): EfficacyEstimate | null {
  if (!e || !display.rescales) return e;
  return {
    ...e,
    estimate: display.delta(e.estimate),
    ciLow: display.delta(e.ciLow),
    ciHigh: display.delta(e.ciHigh),
    standardError: display.delta(e.standardError),
  };
}

/** The segmented effect in the account's unit; the fit itself stays canonical. */
export function displaySegmented(
  seg: EfficacySegmented | null,
  display: EfficacyDisplay,
): EfficacySegmented | null {
  if (!seg || !display.rescales) return seg;
  return {
    ...seg,
    levelChange: displayEstimate(seg.levelChange, display),
    slopeChangePerWeek: displayEstimate(seg.slopeChangePerWeek, display),
    preSlopePerWeek: displayEstimate(seg.preSlopePerWeek, display),
  };
}

/** Read the account columns the efficacy view needs, resolved. */
export async function loadEfficacyAccount(
  userId: string,
): Promise<EfficacyAccount> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      unitPreference: true,
      glucoseUnit: true,
      hasDiabetes: true,
      thresholdsJson: true,
      heightCm: true,
      dateOfBirth: true,
      gender: true,
    },
  });
  return {
    preferences: resolveUnitPreferences(row ?? {}),
    hasDiabetes: row?.hasDiabetes ?? false,
    thresholds: (row?.thresholdsJson ?? null) as ThresholdOverridesJson | null,
    profile: {
      heightCm: row?.heightCm ?? null,
      dateOfBirth: row?.dateOfBirth ?? null,
      gender: row?.gender ?? null,
    },
  };
}
