/**
 * Codes and displays the official HL7 FHIR validator (R4, tx.fhir.org)
 * rejected before v1.39.3, pinned at the values it accepts. A display must be
 * one LOINC or SNOMED CT publishes for the code; a code must be active and
 * mean what the Observation says.
 */
import { describe, expect, it } from "vitest";

import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import { resolveLabCoding } from "@/lib/fhir/lab-loinc";
import type { FhirCoding, FhirObservation } from "@/lib/fhir/types";

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

function codings(overrides: Partial<DoctorReportData>): FhirCoding[] {
  const data = {
    period: {
      days: 90,
      since: "2026-02-02T00:00:00.000Z",
      start: "2026-02-02T00:00:00.000Z",
      end: "2026-05-03T12:00:00.000Z",
    },
    patient: { name: "sample-user", dateOfBirth: null, gender: null },
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
  } as DoctorReportData;
  const bundle = buildFhirDocumentBundle(
    data,
    { insuranceNumber: null },
    FIXED_NOW,
  );
  return bundle.entry
    .map((e) => e.resource)
    .filter((r): r is FhirObservation => r.resourceType === "Observation")
    .flatMap((o) => [
      ...(o.code.coding ?? []),
      ...(o.component ?? []).flatMap((c) => c.code.coding ?? []),
    ]);
}

describe("LOINC displays accepted by the validator", () => {
  it("names the blood-pressure panel and its components as LOINC does", () => {
    const all = codings({
      measurements: {
        BLOOD_PRESSURE_SYS: [
          { value: 120, measuredAt: "2026-04-30T08:00:00.000Z" },
        ],
        BLOOD_PRESSURE_DIA: [
          { value: 78, measuredAt: "2026-04-30T08:00:00.000Z" },
        ],
      },
    });
    const display = (code: string) => all.find((c) => c.code === code)?.display;
    expect(display("85354-9")).toBe(
      "Blood pressure panel with all children optional",
    );
    expect(display("8480-6")).toBe("Systolic blood pressure");
    expect(display("8462-4")).toBe("Diastolic blood pressure");
  });

  it("names medication adherence as LOINC does", () => {
    const all = codings({
      compliance: {
        "med-1": {
          name: "Example Drug",
          total: 10,
          taken: 9,
          skipped: 1,
          missed: 0,
        },
      },
    });
    expect(all.find((c) => c.code === "71799-1")?.display).toBe(
      "Adherence to prescribed medication instructions [Reported]",
    );
  });
});

describe("R4 vital-signs profile codes", () => {
  it("adds the heart-rate and oxygen-saturation magic codes beside the specific ones", () => {
    const all = codings({
      measurements: {
        RESTING_HEART_RATE: [
          { value: 54, measuredAt: "2026-04-30T08:00:00.000Z" },
        ],
        OXYGEN_SATURATION: [
          { value: 97, measuredAt: "2026-04-30T08:00:00.000Z" },
        ],
      },
    });
    const codes = all.map((c) => c.code);
    expect(codes).toEqual(
      expect.arrayContaining(["40443-4", "8867-4", "59408-5", "2708-6"]),
    );
  });
});

describe("medication codings", () => {
  it("carries no display on an ATC coding; the user's name stays on text", () => {
    const bundle = buildFhirDocumentBundle(
      {
        period: {
          days: 90,
          since: "2026-02-02T00:00:00.000Z",
          start: "2026-02-02T00:00:00.000Z",
          end: "2026-05-03T12:00:00.000Z",
        },
        patient: { name: "sample-user", dateOfBirth: null, gender: null },
        practiceName: null,
        measurements: {},
        stats: {},
        glucoseStats: {},
        glucoseRanges: {},
        glucoseClinical: computeGlucoseClinicalMetrics([], { now: FIXED_NOW }),
        glucoseUnit: "mg/dL",
        bmi: null,
        compliance: {},
        medications: [
          { name: "Delix 5", dose: "5mg", schedules: [], atcCode: "C09AA05" },
        ],
        mood: null,
        glp1: null,
      } as unknown as DoctorReportData,
      { insuranceNumber: null },
      FIXED_NOW,
      { germanAtc: true },
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find((r) => r.resourceType === "MedicationStatement");
    if (stmt?.resourceType !== "MedicationStatement") throw new Error("none");
    expect(stmt.medicationCodeableConcept.text).toBe("Delix 5");
    expect(stmt.medicationCodeableConcept.coding).toEqual([
      { system: "http://www.whocc.no/atc", code: "C09AA05" },
      { system: "http://fhir.de/CodeSystem/bfarm/atc", code: "C09AA05" },
    ]);
  });
});

describe("lab LOINC terms", () => {
  it.each([
    // Method-less LDL; 18262-6 is the direct-assay term.
    [
      "LDL-C",
      "mg/dL",
      "2089-1",
      "Cholesterol in LDL [Mass/volume] in Serum or Plasma",
    ],
    // Total 25-OH vitamin D; 1989-3 is D3 alone.
    [
      "Vitamin D",
      "ng/mL",
      "62292-8",
      "25-Hydroxyvitamin D3+25-Hydroxyvitamin D2 [Mass/volume] in Serum or Plasma",
    ],
    // Formula-less eGFR; 33914-3 (MDRD) is DISCOURAGED.
    [
      "eGFR",
      "mL/min/1.73m2",
      "69405-9",
      "Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by based on 1.73 sq M",
    ],
  ])("codes %s as %s", (analyte, unit, code, display) => {
    const coding = resolveLabCoding(analyte, unit);
    expect(coding?.loinc).toBe(code);
    expect(coding?.display).toBe(display);
  });
});
