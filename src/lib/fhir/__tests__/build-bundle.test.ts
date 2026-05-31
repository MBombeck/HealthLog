import { describe, it, expect } from "vitest";
import { buildFhirDocumentBundle } from "../build-bundle";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import type {
  FhirObservation,
  FhirMedicationStatement,
  FhirPatient,
} from "../types";

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
      username: "sample-user",
      dateOfBirth: "1985-06-15T00:00:00.000Z",
      gender: "MALE",
      heightCm: 182,
      fullName: "Sample Patient",
      insurerName: "Example Insurer",
    },
    practiceName: null,
    measurements: {
      WEIGHT: [
        { value: 80, measuredAt: "2026-02-10T08:00:00.000Z" },
        { value: 79.5, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
      BLOOD_PRESSURE_SYS: [
        { value: 120, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
      BLOOD_PRESSURE_DIA: [
        { value: 78, measuredAt: "2026-04-30T08:00:00.000Z" },
      ],
      PULSE: [{ value: 64, measuredAt: "2026-04-30T08:00:00.000Z" }],
    },
    stats: {
      WEIGHT: { avg: 79.75, min: 79.5, max: 80, count: 2, latest: 79.5 },
      BLOOD_PRESSURE_SYS: { avg: 122, min: 118, max: 128, count: 5, latest: 120 },
      BLOOD_PRESSURE_DIA: { avg: 78, min: 72, max: 82, count: 5, latest: 78 },
      PULSE: { avg: 65, min: 58, max: 72, count: 5, latest: 64 },
    },
    glucoseStats: {
      FASTING: { avg: 92, min: 85, max: 100, count: 4, latest: 90 },
    },
    glucoseRanges: { FASTING: { min: 70, max: 99 } },
    glucoseUnit: "mg/dL",
    bmi: 24.1,
    compliance: {
      "Example Drug": { total: 90, taken: 85, skipped: 3, missed: 2 },
    },
    medications: [
      {
        name: "Example Drug",
        dose: "5mg",
        schedules: [
          { windowStart: "08:00", windowEnd: "09:00", label: "Morning" },
        ],
      },
    ],
    mood: null,
    glp1: null,
    ...overrides,
  };
}

describe("buildFhirDocumentBundle", () => {
  it("produces a document Bundle with a leading Composition", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.timestamp).toBe(FIXED_NOW.toISOString());
    expect(bundle.entry[0].resource.resourceType).toBe("Composition");
  });

  it("emits a Patient with name, gender, birthDate and KVNR identifier", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const patient = bundle.entry.find(
      (e) => e.resource.resourceType === "Patient",
    )?.resource as FhirPatient;
    expect(patient).toBeDefined();
    expect(patient.name?.[0].text).toBe("Sample Patient");
    expect(patient.gender).toBe("male");
    expect(patient.birthDate).toBe("1985-06-15");
    expect(patient.identifier?.[0].value).toBe("A123456780");
  });

  it("omits the KVNR identifier when no insurance number is provided", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const patient = bundle.entry.find(
      (e) => e.resource.resourceType === "Patient",
    )?.resource as FhirPatient;
    expect(patient.identifier).toBeUndefined();
  });

  it("maps weight to LOINC 29463-7 / UCUM kg with the latest reading", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const observations = bundle.entry
      .map((e) => e.resource)
      .filter(
        (r): r is FhirObservation => r.resourceType === "Observation",
      );
    const weight = observations.find((o) =>
      o.code.coding?.some((c) => c.code === "29463-7"),
    );
    expect(weight).toBeDefined();
    // Latest reading is the second WEIGHT entry (79.5), matching the
    // PDF's "Current" column.
    expect(weight?.valueQuantity?.value).toBe(79.5);
    expect(weight?.valueQuantity?.code).toBe("kg");
    expect(weight?.effectiveDateTime).toBe("2026-04-30T08:00:00.000Z");
  });

  it("emits a BP panel (85354-9) with sys/dia components", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const observations = bundle.entry
      .map((e) => e.resource)
      .filter(
        (r): r is FhirObservation => r.resourceType === "Observation",
      );
    const bp = observations.find((o) =>
      o.code.coding?.some((c) => c.code === "85354-9"),
    );
    expect(bp).toBeDefined();
    expect(bp?.component).toHaveLength(2);
    const sys = bp?.component?.find((c) =>
      c.code.coding?.some((cc) => cc.code === "8480-6"),
    );
    const dia = bp?.component?.find((c) =>
      c.code.coding?.some((cc) => cc.code === "8462-4"),
    );
    expect(sys?.valueQuantity?.value).toBe(120);
    expect(dia?.valueQuantity?.value).toBe(78);
  });

  it("emits a medication-adherence Observation matching the PDF compliance %", () => {
    const data = makeData();
    const bundle = buildFhirDocumentBundle(
      data,
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const observations = bundle.entry
      .map((e) => e.resource)
      .filter(
        (r): r is FhirObservation => r.resourceType === "Observation",
      );
    const adherence = observations.find((o) =>
      o.code.coding?.some((c) => c.code === "71799-1"),
    );
    // PDF renders taken/total = 85/90 = 94.4%.
    expect(adherence?.valueQuantity?.value).toBeCloseTo(94.4, 1);
  });

  it("emits one MedicationStatement per active medication", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const meds = bundle.entry
      .map((e) => e.resource)
      .filter(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    expect(meds).toHaveLength(1);
    expect(meds[0].medicationCodeableConcept.text).toBe("Example Drug");
    expect(meds[0].dosage?.[0].text).toBe("5mg");
  });

  it("omits the mood Observation when mood is null (privacy default)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ mood: null }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const moodObs = bundle.entry
      .map((e) => e.resource)
      .filter((r): r is FhirObservation => r.resourceType === "Observation")
      .find((o) => o.code.coding?.some((c) => c.code === "76542-6"));
    expect(moodObs).toBeUndefined();
  });

  it("includes the mood Observation only when mood data is present", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        mood: { avg: 3.6, min: 2, max: 5, count: 30, distribution: {} },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const moodObs = bundle.entry
      .map((e) => e.resource)
      .filter((r): r is FhirObservation => r.resourceType === "Observation")
      .find((o) => o.code.coding?.some((c) => c.code === "76542-6"));
    expect(moodObs?.valueQuantity?.value).toBe(3.6);
  });

  it("emits no Observation for a type with no readings (empty domain)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ measurements: {}, glucoseStats: {}, compliance: {}, bmi: null }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const observations = bundle.entry
      .map((e) => e.resource)
      .filter((r) => r.resourceType === "Observation");
    expect(observations).toHaveLength(0);
  });
});
