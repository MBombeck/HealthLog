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
    expect(keys.length).toBeGreaterThanOrEqual(11);
  });
});
