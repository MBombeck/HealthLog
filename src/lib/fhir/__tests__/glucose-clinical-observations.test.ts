import { describe, it, expect } from "vitest";

import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import {
  GLUCOSE_TIR_LOINC,
  GLUCOSE_GMI_LOINC,
  GLUCOSE_MEAN_LOINC,
} from "@/lib/fhir/loinc-map";

import { buildFhirDocumentBundle } from "../build-bundle";
import type { FhirObservation } from "../types";

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

function makeData(overrides?: Partial<DoctorReportData>): DoctorReportData {
  return {
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: {
      name: "sample-user",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
    },
    practiceName: null,
    measurements: {},
    stats: {},
    glucoseStats: {},
    glucoseRanges: {},
    glucoseClinical: computeGlucoseClinicalMetrics([], { now: FIXED_NOW }),
    glucoseUnit: "mg/dL",
    bmi: null,
    compliance: {},
    medications: [],
    mood: null,
    glp1: null,
    ...overrides,
  };
}

function observationsOf(bundle: ReturnType<typeof buildFhirDocumentBundle>) {
  return bundle.entry
    .map((e) => e.resource)
    .filter((r): r is FhirObservation => r.resourceType === "Observation");
}

function codeOf(obs: FhirObservation): string | undefined {
  return obs.code.coding?.[0]?.code;
}

/** Dense daily readings over the window so the panel populates fully. */
function denseReadings(): { measuredAt: Date; mgdl: number }[] {
  const out: { measuredAt: Date; mgdl: number }[] = [];
  for (let d = 0; d < 60; d += 1) {
    for (let h = 0; h < 24; h += 1) {
      out.push({
        measuredAt: new Date(
          FIXED_NOW.getTime() - d * 86_400_000 - h * 3_600_000,
        ),
        // Mostly in-range with a wobble so CV% / TIR are real.
        mgdl: 110 + ((d + h) % 7) * 8,
      });
    }
  }
  return out;
}

describe("clinical glucose-panel FHIR Observations", () => {
  it("emits TIR / GMI / mean / eA1C Observations when glucose readings exist", () => {
    const glucoseClinical = computeGlucoseClinicalMetrics(denseReadings(), {
      now: FIXED_NOW,
      windowDays: 90,
    });
    expect(glucoseClinical.readingCount).toBeGreaterThan(0);

    const bundle = buildFhirDocumentBundle(
      makeData({ glucoseClinical }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const codes = observationsOf(bundle).map(codeOf);

    expect(codes).toContain(GLUCOSE_TIR_LOINC);
    expect(codes).toContain(GLUCOSE_GMI_LOINC);
    expect(codes).toContain(GLUCOSE_MEAN_LOINC);

    // Each coded term carries the display LOINC publishes for it.
    const displayOf = (code: string) =>
      observationsOf(bundle)
        .flatMap((o) => o.code.coding ?? [])
        .find((c) => c.code === code)?.display;
    expect(displayOf(GLUCOSE_TIR_LOINC)).toBe(
      "Glucose measurements in range out of Total glucose measurements during reporting period",
    );
    expect(displayOf(GLUCOSE_GMI_LOINC)).toBe("Glucose management indicator");
    expect(displayOf(GLUCOSE_MEAN_LOINC)).toBe(
      "Average glucose [Mass/volume] in Interstitial fluid during Reporting Period",
    );

    // Estimated A1C is text-only: 41995-2, used before, is a measured
    // "Hemoglobin A1c [Mass/volume] in Blood".
    const ea1c = observationsOf(bundle).find(
      (o) => o.code.text === "Estimated A1C",
    );
    expect(ea1c).toBeDefined();
    expect(ea1c?.code.coding).toBeUndefined();
    expect(codes).not.toContain("41995-2");
  });

  it("emits a percent-valued, UCUM-coded TIR Observation", () => {
    const glucoseClinical = computeGlucoseClinicalMetrics(denseReadings(), {
      now: FIXED_NOW,
      windowDays: 90,
    });
    const bundle = buildFhirDocumentBundle(
      makeData({ glucoseClinical }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const tir = observationsOf(bundle).find(
      (o) => codeOf(o) === GLUCOSE_TIR_LOINC,
    );
    expect(tir).toBeDefined();
    expect(tir!.valueQuantity?.code).toBe("%");
    expect(tir!.valueQuantity?.value).toBeGreaterThan(0);
    expect(tir!.valueQuantity?.value).toBeLessThanOrEqual(100);
  });

  it("codes a continuous-stream mean as 97507-8 in mg/dL, even for a mmol/L account", () => {
    const glucoseClinical = computeGlucoseClinicalMetrics(denseReadings(), {
      now: FIXED_NOW,
      windowDays: 90,
    });
    expect(glucoseClinical.isSpotEstimate).toBe(false);
    const bundle = buildFhirDocumentBundle(
      makeData({ glucoseClinical, glucoseUnit: "mmol/L" }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const mean = observationsOf(bundle).find(
      (o) => o.code.text === "Mean glucose",
    );
    expect(codeOf(mean!)).toBe(GLUCOSE_MEAN_LOINC);
    expect(mean?.valueQuantity?.code).toBe("mg/dL");
    expect(mean?.valueQuantity?.value).toBe(
      Math.round(glucoseClinical.meanMgdl!),
    );
  });

  it("sends a spot-reading mean text-only, in the account's unit", () => {
    // Four readings a day: fingerstick cadence, not a continuous stream.
    const sparse = Array.from({ length: 120 }, (_, i) => ({
      measuredAt: new Date(FIXED_NOW.getTime() - i * 6 * 3_600_000),
      mgdl: 100 + (i % 5) * 10,
    }));
    const glucoseClinical = computeGlucoseClinicalMetrics(sparse, {
      now: FIXED_NOW,
      windowDays: 90,
    });
    expect(glucoseClinical.isSpotEstimate).toBe(true);
    expect(glucoseClinical.meanMgdl).not.toBeNull();
    const bundle = buildFhirDocumentBundle(
      makeData({ glucoseClinical, glucoseUnit: "mmol/L" }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const mean = observationsOf(bundle).find(
      (o) => o.code.text === "Mean glucose",
    );
    expect(mean).toBeDefined();
    expect(mean?.code.coding).toBeUndefined();
    expect(mean?.valueQuantity?.unit).toBe("mmol/L");
    expect(observationsOf(bundle).map(codeOf)).not.toContain(
      GLUCOSE_MEAN_LOINC,
    );
  });

  it("emits NO clinical glucose Observation when the panel has no readings (module off / no data)", () => {
    // Default makeData() has an empty (zero-reading) panel.
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const codes = observationsOf(bundle).map(codeOf);
    expect(codes).not.toContain(GLUCOSE_TIR_LOINC);
    expect(codes).not.toContain(GLUCOSE_GMI_LOINC);
    expect(codes).not.toContain(GLUCOSE_MEAN_LOINC);
    expect(
      observationsOf(bundle).some((o) => o.code.text === "Estimated A1C"),
    ).toBe(false);
  });
});
