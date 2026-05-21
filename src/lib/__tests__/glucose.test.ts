import { describe, it, expect } from "vitest";
import {
  mgdlToMmol,
  convertGlucose,
  resolveGlucoseUnit,
  thresholdMetricForContext,
} from "../glucose";

describe("glucose conversion", () => {
  it("converts mg/dL to mmol/L with 1 decimal", () => {
    expect(mgdlToMmol(100)).toBe(5.5);
    expect(mgdlToMmol(126)).toBeCloseTo(7.0, 1); // diabetes threshold
    expect(mgdlToMmol(70)).toBeCloseTo(3.9, 1); // hypoglycemia threshold
  });

  it("convertGlucose dispatches to the right unit", () => {
    expect(convertGlucose(100, "mg/dL")).toBe(100);
    expect(convertGlucose(100, "mmol/L")).toBe(5.5);
  });

  it("resolveGlucoseUnit defaults to mg/dL", () => {
    expect(resolveGlucoseUnit(null)).toBe("mg/dL");
    expect(resolveGlucoseUnit(undefined)).toBe("mg/dL");
    expect(resolveGlucoseUnit("mmol/L")).toBe("mmol/L");
    expect(resolveGlucoseUnit("mg/dL")).toBe("mg/dL");
    expect(resolveGlucoseUnit("random-garbage")).toBe("mg/dL");
  });

  it("thresholdMetricForContext maps every context", () => {
    expect(thresholdMetricForContext("FASTING")).toBe("BLOOD_GLUCOSE_FASTING");
    expect(thresholdMetricForContext("POSTPRANDIAL")).toBe(
      "BLOOD_GLUCOSE_POSTPRANDIAL",
    );
    expect(thresholdMetricForContext("RANDOM")).toBe("BLOOD_GLUCOSE_RANDOM");
    expect(thresholdMetricForContext("BEDTIME")).toBe("BLOOD_GLUCOSE_BEDTIME");
  });

  // Display-unit logic guard for the targets/dashboard surfaces:
  // canonical mg/dL stays integer; mmol/L stays 1-decimal; ranges convert too.
  it("display unit conversion preserves integer/decimal precision", () => {
    const fastingMin = 70; // mg/dL
    const fastingMax = 99;
    const ada126 = 126; // diabetes threshold

    expect(convertGlucose(fastingMin, "mg/dL")).toBe(70);
    expect(convertGlucose(fastingMax, "mg/dL")).toBe(99);
    expect(convertGlucose(ada126, "mg/dL")).toBe(126);

    expect(convertGlucose(fastingMin, "mmol/L")).toBe(3.9);
    expect(convertGlucose(fastingMax, "mmol/L")).toBe(5.5);
    expect(convertGlucose(ada126, "mmol/L")).toBe(7);
  });
});
