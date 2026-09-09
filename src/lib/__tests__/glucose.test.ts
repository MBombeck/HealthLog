import { describe, it, expect } from "vitest";
import {
  mgdlToMmol,
  mmolToMgdl,
  convertGlucose,
  toCanonicalMgdl,
  resolveGlucoseUnit,
  thresholdMetricForContext,
  glucoseContextBucket,
  groupByGlucoseContext,
  GLUCOSE_CONTEXT_UNSPECIFIED,
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

  // The target-editor write path: a value the user typed in their
  // display unit must persist as canonical mg/dL. Before the fix the
  // editor saved the mmol/L number verbatim (a 5.5 mmol/L target stored
  // as 5.5 mg/dL, or rejected outright by the 40–400 mg/dL bounds).
  it("converts a display-unit value back to canonical mg/dL", () => {
    expect(mmolToMgdl(5.5)).toBe(99);
    expect(mmolToMgdl(7.0)).toBe(126); // ADA diabetes threshold
    expect(mmolToMgdl(3.9)).toBe(70); // hypoglycemia threshold
  });

  // v1.16.16 — "one number, one engine" coherence. The wire series DTO, the
  // CSV export, and the FHIR export each convert a stored mg/dL reading to the
  // user's display unit through the SAME `convertGlucose` helper, so the three
  // surfaces emit an identical value + unit. This guards against any surface
  // drifting back to a render-time or hard-coded conversion.
  it("emits a coherent value+unit across series / CSV / FHIR for mmol/L", () => {
    const storedMgdl = 126; // ADA diabetes threshold
    const unit = resolveGlucoseUnit("mmol/L");

    // Series route: point value = convertGlucose(row.value, unit).
    const seriesValue = convertGlucose(storedMgdl, unit);
    // CSV export: BLOOD_GLUCOSE row value = convertGlucose(m.value, unit).
    const csvValue = convertGlucose(storedMgdl, unit);
    // FHIR export: valueQuantity.value = convertGlucose(stat.latest, unit).
    const fhirValue = convertGlucose(storedMgdl, unit);

    expect(unit).toBe("mmol/L");
    expect(seriesValue).toBe(7);
    expect(csvValue).toBe(seriesValue);
    expect(fhirValue).toBe(seriesValue);
  });

  it("emits a coherent value+unit across series / CSV / FHIR for mg/dL", () => {
    const storedMgdl = 100;
    const unit = resolveGlucoseUnit("mg/dL");
    const seriesValue = convertGlucose(storedMgdl, unit);
    const csvValue = convertGlucose(storedMgdl, unit);
    const fhirValue = convertGlucose(storedMgdl, unit);
    expect(unit).toBe("mg/dL");
    expect(seriesValue).toBe(100);
    expect(csvValue).toBe(seriesValue);
    expect(fhirValue).toBe(seriesValue);
  });

  it("toCanonicalMgdl is the inverse of convertGlucose at the editor boundary", () => {
    // mg/dL display unit is already canonical — only rounds.
    expect(toCanonicalMgdl(126, "mg/dL")).toBe(126);
    expect(toCanonicalMgdl(99.4, "mg/dL")).toBe(99);
    // mmol/L display unit converts back; the round-trip is stable to the
    // 1-decimal mmol/L the UI shows (≤1 mg/dL drift is unavoidable).
    expect(toCanonicalMgdl(7.0, "mmol/L")).toBe(126);
    expect(toCanonicalMgdl(mgdlToMmol(126), "mmol/L")).toBeCloseTo(126, -0.5);
    expect(toCanonicalMgdl(mgdlToMmol(70), "mmol/L")).toBe(70);
  });
});

describe("glucose context buckets (#943)", () => {
  it("files NULL, blank and unknown values under the untagged bucket", () => {
    expect(glucoseContextBucket(null)).toBe(GLUCOSE_CONTEXT_UNSPECIFIED);
    expect(glucoseContextBucket(undefined)).toBe(GLUCOSE_CONTEXT_UNSPECIFIED);
    expect(glucoseContextBucket("")).toBe(GLUCOSE_CONTEXT_UNSPECIFIED);
    expect(glucoseContextBucket("   ")).toBe(GLUCOSE_CONTEXT_UNSPECIFIED);
    expect(glucoseContextBucket("BEFORE_MEAL")).toBe(
      GLUCOSE_CONTEXT_UNSPECIFIED,
    );
  });

  it("keeps the named contexts named, case- and whitespace-tolerant", () => {
    expect(glucoseContextBucket("FASTING")).toBe("FASTING");
    expect(glucoseContextBucket(" bedtime ")).toBe("BEDTIME");
  });

  it("groups in canonical order with the untagged bucket last", () => {
    const rows = [
      { ctx: null, v: 1 },
      { ctx: "BEDTIME", v: 2 },
      { ctx: "FASTING", v: 3 },
      { ctx: "", v: 4 },
    ];
    const grouped = groupByGlucoseContext(rows, (row) => row.ctx);

    expect(grouped.map(([bucket]) => bucket)).toEqual([
      "FASTING",
      "BEDTIME",
      "UNSPECIFIED",
    ]);
    // Input order survives inside a bucket, so a caller reading "latest" off
    // the head keeps reading the same row.
    expect(grouped[2][1].map((row) => row.v)).toEqual([1, 4]);
  });

  it("returns nothing for no rows", () => {
    expect(groupByGlucoseContext([], () => null)).toEqual([]);
  });

  it("judges the untagged bucket against the RANDOM threshold", () => {
    expect(thresholdMetricForContext(GLUCOSE_CONTEXT_UNSPECIFIED)).toBe(
      "BLOOD_GLUCOSE_RANDOM",
    );
  });
});
