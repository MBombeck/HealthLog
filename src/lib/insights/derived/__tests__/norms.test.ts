import { describe, it, expect } from "vitest";
import { lookupNormalRange, predictSixMinuteWalkDistance } from "../norms";

describe("lookupNormalRange — the age/sex reference-range enabler", () => {
  it("returns a sex-specific VO2max band for a registered metric", () => {
    const male = lookupNormalRange("VO2_MAX", 35, "MALE");
    const female = lookupNormalRange("VO2_MAX", 35, "FEMALE");
    expect(male).not.toBeNull();
    expect(female).not.toBeNull();
    // male bands sit higher than female at the same decade
    expect(male!.low).toBeGreaterThan(female!.low);
    expect(male!.high).toBeGreaterThan(female!.high);
  });

  it("narrows resting-HR by age (sex-agnostic)", () => {
    const child = lookupNormalRange("RESTING_HEART_RATE", 4, null);
    const adult = lookupNormalRange("RESTING_HEART_RATE", 40, null);
    expect(child).not.toBeNull();
    expect(adult).not.toBeNull();
    // children run higher than adults
    expect(child!.high).toBeGreaterThan(adult!.high);
  });

  it("returns null when age is absent (falls back to flat anchor)", () => {
    expect(lookupNormalRange("VO2_MAX", null, "MALE")).toBeNull();
    expect(lookupNormalRange("VO2_MAX", undefined, "MALE")).toBeNull();
  });

  it("returns null for a metric with no norm table", () => {
    expect(lookupNormalRange("OXYGEN_SATURATION", 40, "MALE")).toBeNull();
    expect(lookupNormalRange("STEPS", 40, "FEMALE")).toBeNull();
  });

  it("returns null for a sex-specific-only table when profile sex is absent", () => {
    // VO2max is sex-specific only; without a sex we cannot pick one band.
    expect(lookupNormalRange("VO2_MAX", 35, null)).toBeNull();
  });

  it("prefers a sex-agnostic row when present and sex is absent", () => {
    // resting-HR rows are sex-agnostic, so an absent sex still resolves.
    expect(lookupNormalRange("RESTING_HEART_RATE", 40, null)).not.toBeNull();
  });

  it("clamps to the oldest bracket for very high ages", () => {
    const old = lookupNormalRange("VO2_MAX", 95, "FEMALE");
    expect(old).not.toBeNull();
  });

  it("interpolates a fractional age between adjacent brackets (no hard step)", () => {
    // Male VO2max: 30s centre 34.5 → {39,49}; 40s centre 44.5 → {35,45}.
    // At the lower centre the band equals the 30s band exactly.
    const at345 = lookupNormalRange("VO2_MAX", 34.5, "MALE");
    expect(at345).toEqual({ low: 39, high: 49 });
    // Midway between the two centres → halfway between the two bands.
    const at395 = lookupNormalRange("VO2_MAX", 39.5, "MALE");
    expect(at395).toEqual({ low: 37, high: 47 });
    // Just into the 40s the band must move only slightly, not jump.
    const at40 = lookupNormalRange("VO2_MAX", 40, "MALE")!;
    expect(at40.low).toBeGreaterThan(35);
    expect(at40.low).toBeLessThan(37);
    expect(at40.high).toBeGreaterThan(45);
    expect(at40.high).toBeLessThan(47);
  });

  it("the band changes smoothly across a bracket boundary, not in a step", () => {
    // Either side of the 30s/40s boundary (age 40) the bands are close — a
    // hard bracket lookup would have returned two different fixed bands.
    const justBelow = lookupNormalRange("VO2_MAX", 39.9, "MALE")!;
    const justAbove = lookupNormalRange("VO2_MAX", 40.1, "MALE")!;
    expect(Math.abs(justAbove.low - justBelow.low)).toBeLessThan(0.5);
    expect(Math.abs(justAbove.high - justBelow.high)).toBeLessThan(0.5);
  });

  it("holds the youngest band flat below the first bracket centre", () => {
    // Age below the youngest centre clamps to the youngest cited band.
    const young = lookupNormalRange("VO2_MAX", 21, "MALE");
    expect(young).toEqual({ low: 42, high: 53 });
  });

  it("rejects negative / non-finite ages", () => {
    expect(lookupNormalRange("RESTING_HEART_RATE", -5, null)).toBeNull();
    expect(
      lookupNormalRange("RESTING_HEART_RATE", Number.NaN, null),
    ).toBeNull();
  });
});

describe("grip strength — age × sex bands (Dodds 2014 / EWGSOP2 floor)", () => {
  it("steps the band down with age (younger reads against a higher norm)", () => {
    // Male 30s centre 34.5 → {38,51}; male 70s centre 74.5 → {29,39}.
    const young = lookupNormalRange("GRIP_STRENGTH", 34.5, "MALE")!;
    const old = lookupNormalRange("GRIP_STRENGTH", 74.5, "MALE")!;
    expect(young).toEqual({ low: 38, high: 51 });
    expect(old).toEqual({ low: 29, high: 39 });
    expect(young.low).toBeGreaterThan(old.low);
    expect(young.high).toBeGreaterThan(old.high);
  });

  it("classifies by sex within the same age (male band sits above female)", () => {
    const male = lookupNormalRange("GRIP_STRENGTH", 44.5, "MALE")!;
    const female = lookupNormalRange("GRIP_STRENGTH", 44.5, "FEMALE")!;
    expect(male.low).toBeGreaterThan(female.low);
    expect(male.high).toBeGreaterThan(female.high);
  });

  it("never drops the low below the EWGSOP2 cut-off at the oldest band", () => {
    // 80+ centre 100: male low floored at 27, female low floored at 16.
    expect(lookupNormalRange("GRIP_STRENGTH", 100, "MALE")!.low).toBe(27);
    expect(lookupNormalRange("GRIP_STRENGTH", 100, "FEMALE")!.low).toBe(16);
    // Even past the oldest centre the clamp holds the floor.
    expect(lookupNormalRange("GRIP_STRENGTH", 110, "MALE")!.low).toBe(27);
  });

  it("falls back to the sex cut-off band when age is absent", () => {
    expect(lookupNormalRange("GRIP_STRENGTH", null, "MALE")).toEqual({
      low: 27,
      high: 60,
    });
    expect(lookupNormalRange("GRIP_STRENGTH", undefined, "FEMALE")).toEqual({
      low: 16,
      high: 60,
    });
  });

  it("returns null when sex is absent (no honest sex-specific band)", () => {
    expect(lookupNormalRange("GRIP_STRENGTH", 40, null)).toBeNull();
    expect(lookupNormalRange("GRIP_STRENGTH", null, null)).toBeNull();
  });
});

describe("waist circumference — age × sex bands (WHO, raised for elderly)", () => {
  it("holds the WHO threshold through midlife, raising it for older adults", () => {
    // Male 18-49 centre 33.5 → {0,94}; 80+ centre 100 → {0,102}.
    const adult = lookupNormalRange("WAIST_CIRCUMFERENCE", 33.5, "MALE")!;
    const elderly = lookupNormalRange("WAIST_CIRCUMFERENCE", 100, "MALE")!;
    expect(adult).toEqual({ low: 0, high: 94 });
    expect(elderly).toEqual({ low: 0, high: 102 });
    expect(elderly.high).toBeGreaterThan(adult.high);
  });

  it("classifies by sex (the female threshold sits below the male)", () => {
    const male = lookupNormalRange("WAIST_CIRCUMFERENCE", 100, "MALE")!;
    const female = lookupNormalRange("WAIST_CIRCUMFERENCE", 100, "FEMALE")!;
    expect(female.high).toBeLessThan(male.high);
    expect(female).toEqual({ low: 0, high: 88 });
  });

  it("never lowers the threshold below the standard WHO floor", () => {
    for (const age of [18, 25, 40, 55, 65, 75, 90]) {
      expect(
        lookupNormalRange("WAIST_CIRCUMFERENCE", age, "MALE")!.high,
      ).toBeGreaterThanOrEqual(94);
      expect(
        lookupNormalRange("WAIST_CIRCUMFERENCE", age, "FEMALE")!.high,
      ).toBeGreaterThanOrEqual(80);
    }
  });

  it("falls back to the standard WHO threshold when age is absent", () => {
    expect(lookupNormalRange("WAIST_CIRCUMFERENCE", null, "MALE")).toEqual({
      low: 0,
      high: 94,
    });
    expect(lookupNormalRange("WAIST_CIRCUMFERENCE", null, "FEMALE")).toEqual({
      low: 0,
      high: 80,
    });
  });
});

describe("a sharpened band exists only for a metric with an age/sex profile", () => {
  it("mirrors lookupNormalRange truthiness", () => {
    expect(lookupNormalRange("VO2_MAX", 35, "MALE")).not.toBeNull();
    expect(lookupNormalRange("VO2_MAX", 35, null)).toBeNull();
    expect(lookupNormalRange("STEPS", 35, "MALE")).toBeNull();
  });
});

describe("predictSixMinuteWalkDistance — Enright & Sherrill 1998", () => {
  it("matches the published male equation", () => {
    // 7.57·180 − 5.02·40 − 1.76·80 − 309 = 712 m
    expect(predictSixMinuteWalkDistance(40, 180, 80, "MALE")).toBeCloseTo(
      712,
      6,
    );
  });

  it("matches the published female equation", () => {
    // 2.11·165 − 2.29·65 − 5.78·40 + 667 = 635.1 m
    expect(predictSixMinuteWalkDistance(40, 165, 65, "FEMALE")).toBeCloseTo(
      635.1,
      6,
    );
  });

  it("returns null without a usable sex (the equations differ by sex)", () => {
    expect(predictSixMinuteWalkDistance(40, 180, 80, null)).toBeNull();
  });

  it("returns null when weight is absent (no silently-dropped term)", () => {
    expect(predictSixMinuteWalkDistance(40, 180, null, "MALE")).toBeNull();
  });

  it("returns null without height", () => {
    expect(predictSixMinuteWalkDistance(40, null, 80, "MALE")).toBeNull();
  });

  it("returns null for non-adult / non-finite ages", () => {
    expect(predictSixMinuteWalkDistance(12, 150, 45, "MALE")).toBeNull();
    expect(
      predictSixMinuteWalkDistance(Number.NaN, 180, 80, "MALE"),
    ).toBeNull();
    expect(predictSixMinuteWalkDistance(null, 180, 80, "MALE")).toBeNull();
  });
});
