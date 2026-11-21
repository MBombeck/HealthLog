import { describe, it, expect } from "vitest";

import { CITATIONS } from "../medical-citations";
import {
  REFERENCE_RANGES,
  REFERENCE_METRICS,
  classifyReference,
  getReferenceRange,
  isReferenceMetric,
  normalBandIndex,
  referenceLabel,
  type ReferenceMetric,
} from "../reference-ranges";

describe("reference-ranges backbone", () => {
  it("every band + conflict + headline resolves a real citation", () => {
    for (const metric of REFERENCE_METRICS) {
      const range = REFERENCE_RANGES[metric];
      expect(
        CITATIONS[range.referenceId],
        `${metric} referenceId`,
      ).toBeTruthy();
      expect(range.unit, `${metric} unit`).toBeTruthy();
      expect(range.guidanceCaveat, `${metric} guidanceCaveat`).toBeTruthy();
      for (const band of range.bands) {
        expect(
          CITATIONS[band.citation],
          `${metric} band ${band.label}`,
        ).toBeTruthy();
        // A band must pin at least one bound.
        expect(
          band.low != null || band.high != null,
          `${metric} ${band.label}`,
        ).toBe(true);
      }
      for (const conflict of range.conflicts ?? []) {
        expect(CITATIONS[conflict.citation], `${metric} conflict`).toBeTruthy();
        expect(conflict.note).toBeTruthy();
      }
    }
  });

  it("keeps ESH 2023 as the BP headline anchor and surfaces US/EU context", () => {
    const bp = REFERENCE_RANGES.BLOOD_PRESSURE;
    expect(bp.referenceId).toBe("ESH_2023_HYPERTENSION");
    expect(referenceLabel("BLOOD_PRESSURE")).toContain("ESH 2023");
    // ACC/AHA + ESC 2024 ride only as context, never the headline.
    const conflictCitations = (bp.conflicts ?? []).map((c) => c.citation);
    expect(conflictCitations).toContain("ACC_AHA_2017_BP");
    expect(conflictCitations).toContain("ESC_2024_BP");
  });

  it("classifies values into the four-state contract", () => {
    // Within the normal band.
    expect(classifyReference("RESTING_HEART_RATE", 70)).toBe("within");
    expect(classifyReference("BLOOD_GLUCOSE", 90)).toBe("within");
    // Adjacent watch band.
    expect(classifyReference("BLOOD_GLUCOSE", 110)).toBe("slightly-outside");
    // Attention band beyond the watch tier.
    expect(classifyReference("BLOOD_GLUCOSE", 150)).toBe("outside");
    // SpO2 below the healthy floor is attention.
    expect(classifyReference("OXYGEN_SATURATION", 88)).toBe("outside");
    expect(classifyReference("OXYGEN_SATURATION", 98)).toBe("within");
  });

  it("every banded metric marks exactly one normal band", () => {
    for (const metric of REFERENCE_METRICS) {
      const bands = REFERENCE_RANGES[metric].bands;
      if (bands.length === 0) continue;
      const marked = bands.filter((b) => b.normal === true);
      expect(marked, `${metric} normal-band count`).toHaveLength(1);
      // `normalBandIndex` points at that marked band.
      expect(bands[normalBandIndex(metric)].normal, `${metric} index`).toBe(
        true,
      );
    }
  });

  it("resolves the normal band by marker, not by index 0", () => {
    // BMI authors Underweight FIRST; the normal band is the 18.5–24.9 entry.
    expect(REFERENCE_RANGES.BMI.bands[0].label).toBe("Underweight");
    expect(REFERENCE_RANGES.BMI.bands[normalBandIndex("BMI")].label).toBe(
      "Normal",
    );
    // BMI 22 is healthy → within (the index-0 bug reported it slightly-outside).
    expect(classifyReference("BMI", 22)).toBe("within");
    // BMI 17 is underweight → one band below normal → slightly-outside
    // (the index-0 bug reported it as within).
    expect(classifyReference("BMI", 17)).toBe("slightly-outside");
    // BMI 27 overweight (one above) → slightly-outside; 35 obesity (two
    // above) → outside.
    expect(classifyReference("BMI", 27)).toBe("slightly-outside");
    expect(classifyReference("BMI", 35)).toBe("outside");
  });

  it("classifies pulse pressure around its interior normal band", () => {
    // Narrow is the FIRST band; the normal band is "Typical at rest".
    expect(REFERENCE_RANGES.PULSE_PRESSURE.bands[0].label).toBe("Narrow");
    expect(classifyReference("PULSE_PRESSURE", 40)).toBe("within");
    // Narrow (≤25) is one band below normal → slightly-outside.
    expect(classifyReference("PULSE_PRESSURE", 20)).toBe("slightly-outside");
    // Wide (≥60) is one band above normal → slightly-outside.
    expect(classifyReference("PULSE_PRESSURE", 75)).toBe("slightly-outside");
  });

  it("returns insufficient for absent values and band-less metrics", () => {
    expect(classifyReference("RESTING_HEART_RATE", null)).toBe("insufficient");
    expect(classifyReference("RESTING_HEART_RATE", Number.NaN)).toBe(
      "insufficient",
    );
    // HRV carries no fixed population band — baseline-only.
    expect(REFERENCE_RANGES.HEART_RATE_VARIABILITY.bands).toHaveLength(0);
    expect(classifyReference("HEART_RATE_VARIABILITY", 42)).toBe(
      "insufficient",
    );
  });

  it("steps backbone uses the canonical 8,000 green floor", () => {
    const steps = REFERENCE_RANGES.STEPS;
    expect(steps.bands[0].low).toBe(8000);
    expect(steps.referenceId).toBe("STEPS_SAINT_MAURICE_2020");
  });

  it("guards + resolvers narrow correctly", () => {
    expect(isReferenceMetric("BLOOD_PRESSURE")).toBe(true);
    expect(isReferenceMetric("NOT_A_METRIC")).toBe(false);
    expect(getReferenceRange("NOT_A_METRIC")).toBeNull();
    expect(getReferenceRange("HBA1C")).toBe(REFERENCE_RANGES.HBA1C);
  });

  it("no commercial brand appears in any band label or caveat", () => {
    const banned = /apple|withings|oura|whoop|garmin|fitbit|polar|samsung/i;
    for (const metric of REFERENCE_METRICS) {
      const range = REFERENCE_RANGES[metric];
      expect(range.guidanceCaveat).not.toMatch(banned);
      for (const band of range.bands) expect(band.label).not.toMatch(banned);
      for (const conflict of range.conflicts ?? []) {
        expect(conflict.note).not.toMatch(banned);
      }
    }
  });

  it("metric ids stay a closed, non-empty set", () => {
    expect(REFERENCE_METRICS.length).toBeGreaterThan(10);
    const ids = new Set<ReferenceMetric>(REFERENCE_METRICS);
    expect(ids.size).toBe(REFERENCE_METRICS.length);
  });
});
