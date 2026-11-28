import { describe, it, expect } from "vitest";

import { resolveToCanonicalUnit } from "../unit-aliases";
import { MGDL_PER_MMOL, mgdlToMmol } from "@/lib/glucose";

describe("resolveToCanonicalUnit", () => {
  it("passes the canonical unit through case-insensitively", () => {
    expect(resolveToCanonicalUnit("WEIGHT", 80, "kg")).toEqual({
      value: 80,
      unit: "kg",
    });
    expect(resolveToCanonicalUnit("WEIGHT", 80, "KG")).toEqual({
      value: 80,
      unit: "kg",
    });
    expect(resolveToCanonicalUnit("BLOOD_GLUCOSE", 95, "MG/DL")).toEqual({
      value: 95,
      unit: "mg/dL",
    });
  });

  it("converts a lb weight to canonical kg (exact factor)", () => {
    const out = resolveToCanonicalUnit("WEIGHT", 210, "lb");
    expect(out?.unit).toBe("kg");
    expect(out?.value).toBeCloseTo(210 * 0.45359237, 6);
    // aliases
    for (const alias of ["lbs", "pound", "pounds", "LB"]) {
      expect(resolveToCanonicalUnit("WEIGHT", 1, alias)?.unit).toBe("kg");
    }
  });

  it("converts lb for every body-mass metric, not just WEIGHT", () => {
    for (const type of ["MUSCLE_MASS", "FAT_MASS", "BONE_MASS"]) {
      const out = resolveToCanonicalUnit(type, 22.0462, "lb");
      expect(out?.unit).toBe("kg");
      expect(out?.value).toBeCloseTo(10, 3);
    }
  });

  it("converts waist inches to canonical cm", () => {
    const out = resolveToCanonicalUnit("WAIST_CIRCUMFERENCE", 33, "in");
    expect(out?.unit).toBe("cm");
    expect(out?.value).toBeCloseTo(83.82, 2);
  });

  it("converts an absolute °F reading to canonical celsius", () => {
    const out = resolveToCanonicalUnit("BODY_TEMPERATURE", 98.6, "°F");
    expect(out?.unit).toBe("celsius");
    expect(out?.value).toBeCloseTo(37, 5);
    // an explicit celsius spelling also normalises to the canonical string
    expect(resolveToCanonicalUnit("BODY_TEMPERATURE", 37, "°C")).toEqual({
      value: 37,
      unit: "celsius",
    });
  });

  it("converts glucose mmol/L to canonical mg/dL on the app's one factor", () => {
    // This used to assert 18.016 while every display path divided by
    // 18.0182, so a reading imported as mmol/L and read back as mmol/L did
    // not return the number it went in as. Both ends take the same factor
    // now, and the assertion names it rather than repeating a literal —
    // pinning the constant twice is how the two drifted apart.
    const out = resolveToCanonicalUnit("BLOOD_GLUCOSE", 5.3, "mmol/L");
    expect(out?.unit).toBe("mg/dL");
    expect(out?.value).toBe(Math.round(5.3 * MGDL_PER_MMOL * 10) / 10);
    // The round trip a mmol/L reader actually experiences.
    expect(mgdlToMmol(out?.value ?? 0)).toBe(5.3);
  });

  it("refuses an unrecognised or type-mismatched unit (never mis-stores)", () => {
    expect(resolveToCanonicalUnit("WEIGHT", 12, "stone")).toBeNull();
    expect(resolveToCanonicalUnit("WEIGHT", 12, "°F")).toBeNull();
    // lb is not a waist unit
    expect(resolveToCanonicalUnit("WAIST_CIRCUMFERENCE", 12, "lb")).toBeNull();
    // mmol/L is not a weight unit
    expect(resolveToCanonicalUnit("WEIGHT", 12, "mmol/L")).toBeNull();
  });
});
