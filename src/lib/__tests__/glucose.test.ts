import { describe, it, expect } from "vitest";
import {
  mgdlToMmol,
  mmolToMgdl,
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

  it("converts mmol/L to mg/dL rounded to integer", () => {
    expect(mmolToMgdl(5.5)).toBe(99);
    expect(mmolToMgdl(7.0)).toBe(126);
  });

  it("roundtrips within 1 mg/dL", () => {
    for (const mgdl of [70, 99, 100, 126, 140, 200, 300]) {
      const back = mmolToMgdl(mgdlToMmol(mgdl));
      expect(Math.abs(back - mgdl)).toBeLessThanOrEqual(1);
    }
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
});
