import { describe, it, expect } from "vitest";
import {
  getEffectiveRange,
  getAllEffectiveRanges,
  METRIC_BOUNDS,
  type UserProfileForRange,
  type ThresholdOverridesJson,
} from "../effective-range";

const baseProfile: UserProfileForRange = {
  heightCm: 180,
  dateOfBirth: new Date("1985-01-01"),
  gender: "MALE",
};

describe("getEffectiveRange", () => {
  it("returns computed default when no override is set", () => {
    const result = getEffectiveRange("WEIGHT", baseProfile, null);
    expect(result.isOverride).toBe(false);
    expect(result.range).not.toBeNull();
    // BMI 18.5..24.9 at 1.80m ≈ 59.94..80.68
    expect(result.range!.greenMin).toBeCloseTo(59.94, 1);
    expect(result.range!.greenMax).toBeCloseTo(80.68, 1);
  });

  it("returns null range when a prerequisite profile field is missing", () => {
    const result = getEffectiveRange(
      "WEIGHT",
      { heightCm: null, dateOfBirth: null, gender: null },
      null,
    );
    expect(result.range).toBeNull();
    expect(result.default).toBeNull();
  });

  it("uses override when present", () => {
    const overrides: ThresholdOverridesJson = {
      WEIGHT: { min: 70, max: 85 },
    };
    const result = getEffectiveRange("WEIGHT", baseProfile, overrides);
    expect(result.isOverride).toBe(true);
    expect(result.range!.greenMin).toBe(70);
    expect(result.range!.greenMax).toBe(85);
    // Orange wings should be non-degenerate
    expect(result.range!.orangeMin).toBeLessThan(70);
    expect(result.range!.orangeMax).toBeGreaterThan(85);
  });

  it("returns the pristine default alongside the override", () => {
    const overrides: ThresholdOverridesJson = {
      WEIGHT: { min: 70, max: 85 },
    };
    const result = getEffectiveRange("WEIGHT", baseProfile, overrides);
    expect(result.default).not.toBeNull();
    expect(result.default!.greenMin).toBeCloseTo(59.94, 1);
  });

  it("has bounds for every supported metric", () => {
    for (const metric of Object.keys(METRIC_BOUNDS) as Array<
      keyof typeof METRIC_BOUNDS
    >) {
      const result = getEffectiveRange(metric, baseProfile, null);
      expect(result.bounds).toEqual(METRIC_BOUNDS[metric]);
    }
  });

  it("has sensible blood glucose defaults in fasting context", () => {
    const result = getEffectiveRange(
      "BLOOD_GLUCOSE_FASTING",
      baseProfile,
      null,
    );
    expect(result.range!.greenMin).toBe(70);
    expect(result.range!.greenMax).toBe(99);
    expect(result.range!.orangeMax).toBe(125); // pre-diabetes upper
  });

  it("has different defaults for postprandial vs fasting", () => {
    const fasting = getEffectiveRange("BLOOD_GLUCOSE_FASTING", baseProfile, null);
    const post = getEffectiveRange("BLOOD_GLUCOSE_POSTPRANDIAL", baseProfile, null);
    expect(post.range!.greenMax).toBeGreaterThan(fasting.range!.greenMax);
  });
});

describe("getAllEffectiveRanges", () => {
  it("returns an entry for every metric", () => {
    const ranges = getAllEffectiveRanges(baseProfile, null);
    const keys = Object.keys(ranges);
    expect(keys).toContain("WEIGHT");
    expect(keys).toContain("BLOOD_GLUCOSE_FASTING");
    expect(keys).toContain("TOTAL_BODY_WATER");
    expect(keys).toContain("BONE_MASS");
    expect(keys).toContain("OXYGEN_SATURATION");
    expect(keys.length).toBeGreaterThanOrEqual(14);
  });
});

// Audit-2026-05-07 / phase P0 / closes audit C-15: TOTAL_BODY_WATER and
// BONE_MASS lacked threshold definitions. Severity logic returned `nominal`
// for any value, so users would see "all healthy" regardless of input.
describe("body composition thresholds", () => {
  it("TOTAL_BODY_WATER has a sensible non-null green band", () => {
    const result = getEffectiveRange("TOTAL_BODY_WATER", baseProfile, null);
    expect(result.range).not.toBeNull();
    expect(result.range!.greenMin).toBeGreaterThan(0);
    expect(result.range!.greenMax).toBeGreaterThan(result.range!.greenMin);
    expect(result.range!.orangeMin).toBeLessThan(result.range!.greenMin);
    expect(result.range!.orangeMax).toBeGreaterThan(result.range!.greenMax);
  });

  it("BONE_MASS has a sensible non-null green band", () => {
    const result = getEffectiveRange("BONE_MASS", baseProfile, null);
    expect(result.range).not.toBeNull();
    expect(result.range!.greenMin).toBeGreaterThan(0);
    expect(result.range!.greenMax).toBeGreaterThan(result.range!.greenMin);
  });

  it("respects user override for body water", () => {
    const overrides: ThresholdOverridesJson = {
      TOTAL_BODY_WATER: { min: 30, max: 45 },
    };
    const result = getEffectiveRange(
      "TOTAL_BODY_WATER",
      baseProfile,
      overrides,
    );
    expect(result.isOverride).toBe(true);
    expect(result.range!.greenMin).toBe(30);
    expect(result.range!.greenMax).toBe(45);
  });

  it("METRIC_BOUNDS for body composition match VALUE_RANGES in validation", () => {
    expect(METRIC_BOUNDS.TOTAL_BODY_WATER).toEqual({
      min: 5,
      max: 100,
      unit: "kg",
    });
    expect(METRIC_BOUNDS.BONE_MASS).toEqual({ min: 0.5, max: 8, unit: "kg" });
  });
});

// Audit-2026-05-07 / v1.3.3: SpO2 (pulse oximetry) added as a single-value
// metric with lower-only severity (saturation cannot exceed 100% by definition).
// Defaults follow BTS Guideline 2017 (target 94–98%) and ATS clinical practice
// (≥95% at rest is healthy). Below 92% triggers orange band; below 88% in
// real-world clinical literature is the ER threshold.
describe("OXYGEN_SATURATION thresholds", () => {
  it("has a non-null green band centred on the BTS healthy range", () => {
    const result = getEffectiveRange("OXYGEN_SATURATION", baseProfile, null);
    expect(result.range).not.toBeNull();
    expect(result.range!.greenMin).toBe(95);
    expect(result.range!.greenMax).toBe(100);
  });

  it("collapses upper orange wing to greenMax (no upper concern)", () => {
    const result = getEffectiveRange("OXYGEN_SATURATION", baseProfile, null);
    expect(result.range!.orangeMax).toBe(result.range!.greenMax);
  });

  it("respects user override (e.g. COPD baseline 88-92)", () => {
    const overrides: ThresholdOverridesJson = {
      OXYGEN_SATURATION: { min: 88, max: 92 },
    };
    const result = getEffectiveRange(
      "OXYGEN_SATURATION",
      baseProfile,
      overrides,
    );
    expect(result.isOverride).toBe(true);
    expect(result.range!.greenMin).toBe(88);
    expect(result.range!.greenMax).toBe(92);
  });

  it("clamps override orangeMax to physiological 100% (no impossible saturations)", () => {
    // Without the bounds clamp this used to emit orangeMax = 100.75.
    const overrides: ThresholdOverridesJson = {
      OXYGEN_SATURATION: { min: 95, max: 100 },
    };
    const result = getEffectiveRange(
      "OXYGEN_SATURATION",
      baseProfile,
      overrides,
    );
    expect(result.range!.orangeMax).toBeLessThanOrEqual(100);
    expect(result.range!.orangeMin).toBeGreaterThanOrEqual(50);
  });

  it("METRIC_BOUNDS plausibility floor is 50% (incompatible-with-life below)", () => {
    expect(METRIC_BOUNDS.OXYGEN_SATURATION).toEqual({
      min: 50,
      max: 100,
      unit: "%",
    });
  });
});
