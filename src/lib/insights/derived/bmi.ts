/**
 * v1.10.0 — catalogue metric #9: BMI from weight + height.
 *
 * `computeBmi(userId, profile, opts)` derives body-mass index from the
 * latest `WEIGHT` reading and the profile `heightCm`, as the fallback for
 * users whose device never sent a `BODY_MASS_INDEX` row. When a device BMI
 * exists it is preferred upstream via the source ladder; this metric fills
 * the gap for manual / scale-only data.
 *
 *   - **bmi** = kg ÷ m² (exact).
 *   - **band** — WHO classification placed on the green/yellow/red
 *     vocabulary: 18.5–24.9 normal (green); 25–29.9 overweight OR < 18.5
 *     underweight (yellow); ≥ 30 obese (red).
 *   - **category** — the WHO label (underweight / normal / overweight /
 *     obese) for the framing line.
 *
 * Standard: WHO BMI classification (WHO Technical Report Series 894, 2000,
 * "Obesity: preventing and managing the global epidemic"). BMI is a
 * population screen, not a body-composition measure — `BODY_FAT` /
 * `MUSCLE_MASS` are richer where available.
 *
 * Server-only — reads the latest `WEIGHT` row via Prisma; height comes from
 * the caller's profile. The classification helper is exported pure for the
 * unit tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  classifyBMI,
  type BmiClassification,
} from "@/lib/analytics/classifications";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import type { BaselineProfile } from "./baseline";
import { SPARKLINE_MAX_POINTS, type Derived } from "./types";

const WEIGHT_TYPE: MeasurementType = "WEIGHT";
/** A weight reading older than this no longer reflects current BMI. */
const DEFAULT_WINDOW_DAYS = 90;

/** Green/yellow/red placement, same vocabulary as the design-system tokens. */
export type BmiBand = "green" | "yellow" | "red";
/** WHO weight-status category. */
export type BmiCategory = "underweight" | "normal" | "overweight" | "obese";

/** The successful `value` payload for the BMI metric. */
export interface BmiValue {
  /** Body-mass index (kg/m²). */
  bmi: number;
  /** WHO weight-status category. */
  category: BmiCategory;
  /** Band placement for the colour grammar. */
  band: BmiBand;
  /** The weight that backed the value (kg). */
  weightKg: number;
  /** The height used (cm). */
  heightCm: number;
  /**
   * Trailing BMI series (oldest → newest), capped to the last
   * `SPARKLINE_MAX_POINTS`. Derived from the recent weight readings at the
   * fixed profile height — a bounded read, not a per-day rollup.
   */
  series: number[];
}

const CATEGORY_OF: Readonly<Record<string, BmiCategory>> = {
  Underweight: "underweight",
  Normal: "normal",
  Overweight: "overweight",
};

const BAND_OF: Readonly<Record<BmiClassification["severity"], BmiBand>> = {
  normal: "green",
  warning: "yellow",
  danger: "red",
};

/**
 * WHO category + band for a BMI value, in this payload's vocabulary. The
 * cut-offs are `classifyBMI`'s, so the derived card and the targets panel
 * cannot disagree about where a reading falls. Pure.
 */
export function classifyBmi(bmi: number): {
  category: BmiCategory;
  band: BmiBand;
} {
  const { category, severity } = classifyBMI(bmi);
  return {
    category: CATEGORY_OF[category] ?? "obese",
    band: BAND_OF[severity],
  };
}

/**
 * BMI from weight + height. Returns `insufficient` when the profile has no
 * usable height or no recent weight reading; otherwise an exact `ok` value.
 */
export async function computeBmi(
  userId: string,
  profile: BaselineProfile,
  opts?: { windowDays?: number; now?: Date },
): Promise<Derived<BmiValue>> {
  const now = opts?.now ?? new Date();
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS;
  const computedAt = nowProvenanceTimestamp(now);
  const heightCm = profile.heightCm ?? null;

  // No usable height → cannot derive BMI; name height as the missing input.
  if (heightCm == null || !Number.isFinite(heightCm) || heightCm <= 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: 2,
      presentInputs: 0,
      historyDays: 0,
      missing: [WEIGHT_TYPE, "HEIGHT"],
      fullHistoryDays: 1,
    });
    return buildInsufficient<BmiValue>({
      coverage,
      provenance: {
        inputs: [WEIGHT_TYPE, "HEIGHT"],
        source: "none",
        windowDays,
        computedAt,
      },
      reason: "no_height_on_profile",
    });
  }

  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  // Bounded read of the recent weights — the latest backs the BMI value, the
  // trailing set backs the inline sparkline (a small cap, not a per-day walk).
  const weights = await prisma.measurement.findMany({
    where: {
      userId,
      type: WEIGHT_TYPE,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "desc" },
    take: SPARKLINE_MAX_POINTS,
    select: { value: true },
  });
  const latest = weights[0] ?? null;

  if (!latest) {
    // Height present but no recent weight → missing the weight input only.
    const { coverage } = deriveCoverage({
      requiredInputs: 2,
      presentInputs: 1,
      historyDays: 0,
      missing: [WEIGHT_TYPE],
      fullHistoryDays: 1,
    });
    return buildInsufficient<BmiValue>({
      coverage,
      provenance: {
        inputs: ["HEIGHT"],
        source: "none",
        windowDays,
        computedAt,
      },
      reason: "no_weight_in_window",
    });
  }

  const weightKg = latest.value;
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  const { category, band } = classifyBmi(bmi);

  // BMI series from the recent weights at the fixed height; rows are
  // newest-first, the sparkline wants oldest → newest.
  const series = weights
    .map((w) => Math.round((w.value / (heightM * heightM)) * 10) / 10)
    .reverse();

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 2,
    presentInputs: 2,
    historyDays: 1,
    missing: [],
    fullHistoryDays: 1,
  });

  return buildOk<BmiValue>({
    value: {
      bmi: Math.round(bmi * 10) / 10,
      category,
      band,
      weightKg,
      heightCm,
      series,
    },
    coverage,
    confidence,
    provenance: {
      inputs: [WEIGHT_TYPE, "HEIGHT"],
      source: "live",
      windowDays,
      computedAt,
    },
  });
}
