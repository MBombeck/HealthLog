import { describe, it, expect } from "vitest";
import { buildFhirDocumentBundle } from "../build-bundle";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type {
  FhirObservation,
  FhirMedicationStatement,
  FhirMedicationAdministration,
  FhirPatient,
  FhirCoverage,
  FhirDiagnosticReport,
  FhirComposition,
} from "../types";

function administrationsOf(
  bundle: ReturnType<typeof buildFhirDocumentBundle>,
): FhirMedicationAdministration[] {
  return bundle.entry
    .map((e) => e.resource)
    .filter(
      (r): r is FhirMedicationAdministration =>
        r.resourceType === "MedicationAdministration",
    );
}

function coverageOf(
  bundle: ReturnType<typeof buildFhirDocumentBundle>,
): FhirCoverage | undefined {
  return bundle.entry
    .map((e) => e.resource)
    .find((r): r is FhirCoverage => r.resourceType === "Coverage");
}

function observationsOf(bundle: ReturnType<typeof buildFhirDocumentBundle>) {
  return bundle.entry
    .map((e) => e.resource)
    .filter((r): r is FhirObservation => r.resourceType === "Observation");
}

/**
 * Follow an intra-document reference the way a receiver does: match it against
 * `Bundle.entry.fullUrl`. Every internal reference is a `urn:uuid`, so
 * asserting the literal string would only pin the UUID generator.
 */
function resolveRef(
  bundle: ReturnType<typeof buildFhirDocumentBundle>,
  reference: string | undefined,
) {
  return bundle.entry.find((e) => e.fullUrl === reference)?.resource;
}

/** `"Patient/patient-1"` for whatever entry the reference resolves to. */
function refTarget(
  bundle: ReturnType<typeof buildFhirDocumentBundle>,
  reference: string | undefined,
): string | undefined {
  const resource = resolveRef(bundle, reference);
  return resource ? `${resource.resourceType}/${resource.id}` : undefined;
}

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
      BLOOD_PRESSURE_SYS: {
        avg: 122,
        min: 118,
        max: 128,
        count: 5,
        latest: 120,
      },
      BLOOD_PRESSURE_DIA: { avg: 78, min: 72, max: 82, count: 5, latest: 78 },
      PULSE: { avg: 65, min: 58, max: 72, count: 5, latest: 64 },
    },
    glucoseStats: {
      FASTING: { avg: 92, min: 85, max: 100, count: 4, latest: 90 },
    },
    glucoseRanges: { FASTING: { min: 70, max: 99 } },
    glucoseClinical: computeGlucoseClinicalMetrics([], {
      now: new Date("2026-05-03T12:00:00.000Z"),
    }),
    glucoseUnit: "mg/dL",
    bmi: 24.1,
    compliance: {
      "med-example": {
        name: "Example Drug",
        total: 90,
        taken: 85,
        skipped: 3,
        missed: 2,
      },
    },
    medications: [
      {
        id: "med-example-drug",
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

  it("emits a Coverage with a contained Organization carrying the IKNR + subscriberId KVNR", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        patient: {
          username: "sample-user",
          dateOfBirth: "1985-06-15T00:00:00.000Z",
          gender: "MALE",
          heightCm: 182,
          fullName: "Sample Patient",
          insurerName: "Example Insurer",
          insurerIkNumber: "101234567",
        },
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const coverage = coverageOf(bundle);
    expect(coverage).toBeDefined();
    expect(coverage?.status).toBe("active");
    expect(refTarget(bundle, coverage?.beneficiary.reference)).toBe(
      "Patient/patient-1",
    );
    expect(coverage?.subscriberId).toBe("A123456780");
    // Payor references the contained Organization via a local #-ref.
    const payorRef = coverage?.payor?.[0].reference;
    expect(payorRef?.startsWith("#")).toBe(true);
    const org = coverage?.contained?.[0];
    expect(org?.resourceType).toBe("Organization");
    expect(`#${org?.id}`).toBe(payorRef);
    expect(org?.name).toBe("Example Insurer");
    expect(org?.identifier?.[0].system).toBe("http://fhir.de/sid/arge-ik/iknr");
    expect(org?.identifier?.[0].value).toBe("101234567");
  });

  it("places the Coverage right after the Patient in the bundle", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        patient: {
          username: "sample-user",
          dateOfBirth: null,
          gender: null,
          heightCm: null,
          fullName: "Sample Patient",
          insurerName: "Example Insurer",
          insurerIkNumber: "101234567",
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const types = bundle.entry.map((e) => e.resource.resourceType);
    const patientIdx = types.indexOf("Patient");
    const coverageIdx = types.indexOf("Coverage");
    expect(patientIdx).toBeGreaterThanOrEqual(0);
    expect(coverageIdx).toBe(patientIdx + 1);
  });

  it("emits a name-only payor Organization when the IKNR is absent", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        patient: {
          username: "sample-user",
          dateOfBirth: null,
          gender: null,
          heightCm: null,
          fullName: "Sample Patient",
          insurerName: "Example Insurer",
          // no insurerIkNumber
        },
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const coverage = coverageOf(bundle);
    expect(coverage).toBeDefined();
    expect(coverage?.subscriberId).toBe("A123456780");
    const org = coverage?.contained?.[0];
    expect(org?.name).toBe("Example Insurer");
    expect(org?.identifier).toBeUndefined();
  });

  it("emits a Coverage with no subscriberId when the KVNR is absent", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        patient: {
          username: "sample-user",
          dateOfBirth: null,
          gender: null,
          heightCm: null,
          fullName: "Sample Patient",
          insurerName: "Example Insurer",
          insurerIkNumber: "101234567",
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const coverage = coverageOf(bundle);
    expect(coverage).toBeDefined();
    expect(coverage?.subscriberId).toBeUndefined();
    expect(coverage?.contained?.[0].identifier?.[0].value).toBe("101234567");
  });

  it("omits the Coverage entirely when there is no payor signal at all", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        patient: {
          username: "sample-user",
          dateOfBirth: null,
          gender: null,
          heightCm: null,
          fullName: "Sample Patient",
          // neither insurerName nor insurerIkNumber
        },
      }),
      // ...and no KVNR.
      { insuranceNumber: null },
      FIXED_NOW,
    );
    expect(coverageOf(bundle)).toBeUndefined();
  });

  it("emits no Coverage for a bare KVNR — a Coverage needs a payor", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        patient: {
          username: "sample-user",
          dateOfBirth: null,
          gender: null,
          heightCm: null,
          fullName: "Sample Patient",
          // neither insurerName nor insurerIkNumber — just a bare KVNR.
        },
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    // R4 marks `Coverage.payor` 1..*: with no insurer name and no IKNR there
    // is nobody to name, and a Coverage that names no payor is not one.
    expect(coverageOf(bundle)).toBeUndefined();
    // Nothing is lost — the member id rides Patient.identifier.
    const patient = bundle.entry.find(
      (e) => e.resource.resourceType === "Patient",
    )?.resource as FhirPatient;
    expect(patient.identifier?.[0].value).toBe("A123456780");
  });

  it("emits a top-level Composition.text narrative", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const composition = bundle.entry[0].resource;
    expect(composition.resourceType).toBe("Composition");
    if (composition.resourceType === "Composition") {
      expect(composition.text?.status).toBe("generated");
      expect(composition.text?.div).toContain("Health record for");
    }
  });

  it("discloses an administration truncation in the Composition narrative", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Mounjaro",
            effectiveAt: "2026-04-30T08:00:00.000Z",
            status: "completed",
            doseText: "10mg",
            dose: { value: 10, unit: "mg" },
            injectionSite: null,
            atcCode: null,
            rxNormCode: null,
            deliveryForm: "INJECTION",
          },
        ],
        medicationAdministrationsTruncation: { total: 2920, included: 1000 },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const composition = bundle.entry[0].resource;
    if (composition.resourceType === "Composition") {
      expect(composition.text?.div).toContain(
        "Medication administrations truncated: showing the most recent 1000 of 2920",
      );
    }
  });

  it("omits the truncation sentence when nothing was capped", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ medicationAdministrationsTruncation: null }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const composition = bundle.entry[0].resource;
    if (composition.resourceType === "Composition") {
      expect(composition.text?.div).not.toContain("truncated");
    }
  });

  it("maps weight to LOINC 29463-7 / UCUM kg with the latest reading", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const observations = bundle.entry
      .map((e) => e.resource)
      .filter((r): r is FhirObservation => r.resourceType === "Observation");
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
      .filter((r): r is FhirObservation => r.resourceType === "Observation");
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
      .filter((r): r is FhirObservation => r.resourceType === "Observation");
    const adherence = observations.find((o) =>
      o.code.coding?.some((c) => c.code === "71799-1"),
    );
    // taken/total = 85/90 = 94.4% → rounded to the app's integer convention
    // (PDF + FHIR now share one rounding source of truth).
    expect(adherence?.valueQuantity?.value).toBe(94);
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

  it("emits one statement per course with its period and status (v1.40, #1024)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medications: [
          {
            id: "med-tamiflu",
            name: "Tamiflu",
            dose: "75 mg",
            schedules: [],
            courses: [
              { startsOn: "2026-03-01", endsOn: "2026-03-07", status: "ENDED" },
              { startsOn: "2026-06-10", endsOn: null, status: "CURRENT" },
            ],
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const meds = bundle.entry
      .map((e) => e.resource)
      .filter(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    expect(meds.map((m) => [m.status, m.effectivePeriod])).toEqual([
      ["completed", { start: "2026-03-01", end: "2026-03-07" }],
      ["active", { start: "2026-06-10" }],
    ]);
    expect(new Set(meds.map((m) => m.id)).size).toBe(2);
  });

  it("keeps a text-only medicationCodeableConcept when no codes are stored", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    // Pre-v1.9.0 shape: text anchor, no coding[].
    expect(stmt?.medicationCodeableConcept.text).toBe("Example Drug");
    expect(stmt?.medicationCodeableConcept.coding).toBeUndefined();
  });

  it("emits ATC (primary) + RxNorm (secondary) codings when both are stored", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medications: [
          {
            id: "med-mounjaro",
            name: "Mounjaro",
            dose: "10mg",
            atcCode: "A10BX10",
            rxNormCode: "2601723",
            schedules: [],
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    const coding = stmt?.medicationCodeableConcept.coding;
    expect(stmt?.medicationCodeableConcept.text).toBe("Mounjaro");
    expect(coding).toHaveLength(2);
    // ATC is primary (first). No display: the user's name is not the ATC
    // name for the code, and the validator rejects it; the name is `.text`.
    expect(coding?.[0]).toEqual({
      system: "http://www.whocc.no/atc",
      code: "A10BX10",
    });
    // RxNorm is secondary, no display.
    expect(coding?.[1]).toEqual({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "2601723",
    });
  });

  it("emits only the ATC coding when RxNorm is absent", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medications: [
          {
            id: "med-ramipril",
            name: "Ramipril",
            dose: "5mg",
            atcCode: "C09AA05",
            schedules: [],
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    const coding = stmt?.medicationCodeableConcept.coding;
    expect(coding).toHaveLength(1);
    expect(coding?.[0].system).toBe("http://www.whocc.no/atc");
    expect(coding?.[0].code).toBe("C09AA05");
  });

  it("maps a taken intake to a completed MedicationAdministration with a structured dose", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Mounjaro",
            effectiveAt: "2026-04-30T08:12:00.000Z",
            status: "completed",
            doseText: "10mg",
            dose: { value: 10, unit: "mg" },
            injectionSite: "ABDOMEN_LEFT",
            atcCode: "A10BX10",
            rxNormCode: "2601723",
            deliveryForm: "INJECTION",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const admins = administrationsOf(bundle);
    expect(admins).toHaveLength(1);
    const a = admins[0];
    expect(a.status).toBe("completed");
    expect(a.effectiveDateTime).toBe("2026-04-30T08:12:00.000Z");
    // Self-describing concept reuses the ATC/RxNorm coding + text anchor.
    expect(a.medicationCodeableConcept.text).toBe("Mounjaro");
    expect(a.medicationCodeableConcept.coding?.[0].code).toBe("A10BX10");
    // Structured dose satisfies the R4 dose-or-rate invariant.
    expect(a.dosage?.dose).toEqual({
      value: 10,
      unit: "mg",
      system: "http://unitsofmeasure.org",
      code: "mg",
    });
    expect(a.dosage?.text).toBe("10mg");
    // Route carries an additive SNOMED coding (INJECTION → subcutaneous) plus
    // the unchanged `.text` anchor.
    expect(a.dosage?.route?.text).toBe("Injection");
    expect(a.dosage?.route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "34206005",
      display: "Subcutaneous route",
    });
    // Site `.text` is the raw enum value (laterality preserved); the SNOMED
    // coding collapses to the gross body region.
    expect(a.dosage?.site?.text).toBe("ABDOMEN_LEFT");
    expect(a.dosage?.site?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "818983003",
      display: "Abdomen",
    });
  });

  it("maps a skipped intake to a not-done administration with no dosage", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Ramipril",
            effectiveAt: "2026-04-29T08:00:00.000Z",
            status: "not-done",
            doseText: "5mg",
            dose: null,
            injectionSite: null,
            atcCode: null,
            rxNormCode: null,
            deliveryForm: "ORAL",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const admins = administrationsOf(bundle);
    expect(admins).toHaveLength(1);
    expect(admins[0].status).toBe("not-done");
    expect(admins[0].effectiveDateTime).toBe("2026-04-29T08:00:00.000Z");
    // No structured dose → no dosage block (R4 dose-or-rate invariant).
    expect(admins[0].dosage).toBeUndefined();
    // Text-only concept when the medication has no codes.
    expect(admins[0].medicationCodeableConcept.coding).toBeUndefined();
    expect(admins[0].medicationCodeableConcept.text).toBe("Ramipril");
  });

  it("omits the dosage when a taken dose has no structured dose Quantity", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Vitamin D3",
            effectiveAt: "2026-04-30T20:00:00.000Z",
            status: "completed",
            doseText: "1000 IU",
            dose: null,
            injectionSite: null,
            atcCode: null,
            rxNormCode: null,
            deliveryForm: "ORAL",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const a = administrationsOf(bundle)[0];
    expect(a.status).toBe("completed");
    // A dosage with only `.text` would violate the dose-or-rate
    // invariant; the builder omits the dosage entirely instead.
    expect(a.dosage).toBeUndefined();
  });

  it("emits no MedicationAdministration when there are no acted intakes", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ medicationAdministrations: [] }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    expect(administrationsOf(bundle)).toHaveLength(0);
  });

  it("references the administrations from the Medications composition section", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Mounjaro",
            effectiveAt: "2026-04-30T08:12:00.000Z",
            status: "completed",
            doseText: "10mg",
            dose: { value: 10, unit: "mg" },
            injectionSite: null,
            atcCode: null,
            rxNormCode: null,
            deliveryForm: "INJECTION",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const composition = bundle.entry[0].resource;
    expect(composition.resourceType).toBe("Composition");
    const medSection =
      composition.resourceType === "Composition"
        ? composition.section?.find((s) => s.title === "Medications")
        : undefined;
    const refs = (medSection?.entry ?? []).map((e) =>
      refTarget(bundle, e.reference),
    );
    expect(refs).toContain("MedicationAdministration/medadmin-1");
  });

  it("emits the oral SNOMED route coding alongside the unchanged `.text`", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Metformin",
            effectiveAt: "2026-04-30T08:00:00.000Z",
            status: "completed",
            doseText: "500mg",
            dose: { value: 500, unit: "mg" },
            injectionSite: null,
            atcCode: null,
            rxNormCode: null,
            deliveryForm: "ORAL",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const route = administrationsOf(bundle)[0].dosage?.route;
    expect(route?.text).toBe("Oral");
    expect(route?.coding?.[0]).toEqual({
      system: "http://snomed.info/sct",
      code: "26643006",
      display: "Oral route",
    });
  });

  it("maps every InjectionSite enum value to its body-region SNOMED concept, preserving laterality in `.text`", () => {
    const cases: Array<[string, string, string]> = [
      ["ABDOMEN_LEFT", "818983003", "Abdomen"],
      ["ABDOMEN_RIGHT", "818983003", "Abdomen"],
      ["ABDOMEN_UPPER_LEFT", "818983003", "Abdomen"],
      ["ABDOMEN_UPPER_RIGHT", "818983003", "Abdomen"],
      ["THIGH_LEFT", "68367000", "Thigh structure"],
      ["THIGH_RIGHT", "68367000", "Thigh structure"],
      ["UPPER_ARM_LEFT", "40983000", "Upper arm structure"],
      ["UPPER_ARM_RIGHT", "40983000", "Upper arm structure"],
    ];
    for (const [site, code, display] of cases) {
      const bundle = buildFhirDocumentBundle(
        makeData({
          medicationAdministrations: [
            {
              medicationName: "Mounjaro",
              effectiveAt: "2026-04-30T08:12:00.000Z",
              status: "completed",
              doseText: "10mg",
              dose: { value: 10, unit: "mg" },
              injectionSite: site,
              atcCode: null,
              rxNormCode: null,
              deliveryForm: "INJECTION",
            },
          ],
        }),
        { insuranceNumber: null },
        FIXED_NOW,
      );
      const fhirSite = administrationsOf(bundle)[0].dosage?.site;
      // Laterality / quadrant survives verbatim on the `.text` anchor.
      expect(fhirSite?.text).toBe(site);
      expect(fhirSite?.coding?.[0]).toEqual({
        system: "http://snomed.info/sct",
        code,
        display,
      });
    }
  });

  it("emits no route for an unknown delivery form and no site when absent", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medicationAdministrations: [
          {
            medicationName: "Mystery",
            effectiveAt: "2026-04-30T08:00:00.000Z",
            status: "completed",
            doseText: "1 unit",
            dose: { value: 1, unit: "unit" },
            injectionSite: null,
            atcCode: null,
            rxNormCode: null,
            deliveryForm: "TOPICAL",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const dosage = administrationsOf(bundle)[0].dosage;
    expect(dosage?.route).toBeUndefined();
    expect(dosage?.site).toBeUndefined();
  });

  it("emits exactly the WHO ATC coding by default (no BfArM appended)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medications: [
          {
            id: "med-empagliflozin",
            name: "Empagliflozin",
            dose: "10mg",
            atcCode: "A10BK03",
            schedules: [],
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    const coding = stmt?.medicationCodeableConcept.coding;
    expect(coding).toHaveLength(1);
    expect(coding?.[0].system).toBe("http://www.whocc.no/atc");
    expect(
      coding?.some((c) => c.system === "http://fhir.de/CodeSystem/bfarm/atc"),
    ).toBe(false);
  });

  it("appends the BfArM ATC coding AFTER the WHO entry when germanAtc is on", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medications: [
          {
            id: "med-empagliflozin",
            name: "Empagliflozin",
            dose: "10mg",
            atcCode: "A10BK03",
            schedules: [],
          },
        ],
        medicationAdministrations: [
          {
            medicationName: "Empagliflozin",
            effectiveAt: "2026-04-30T08:00:00.000Z",
            status: "completed",
            doseText: "10mg",
            dose: { value: 10, unit: "mg" },
            injectionSite: null,
            atcCode: "A10BK03",
            rxNormCode: "1545150",
            deliveryForm: "ORAL",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
      { germanAtc: true },
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    const stmtCoding = stmt?.medicationCodeableConcept.coding;
    // WHO stays coding[0], byte-identical.
    expect(stmtCoding?.[0]).toEqual({
      system: "http://www.whocc.no/atc",
      code: "A10BK03",
    });
    expect(stmtCoding?.[1]).toEqual({
      system: "http://fhir.de/CodeSystem/bfarm/atc",
      code: "A10BK03",
    });
    expect(stmt?.medicationCodeableConcept.text).toBe("Empagliflozin");

    // The administration concept reflects the flag identically; RxNorm follows.
    const adminCoding =
      administrationsOf(bundle)[0].medicationCodeableConcept.coding;
    expect(adminCoding?.[0].system).toBe("http://www.whocc.no/atc");
    expect(adminCoding?.[1].system).toBe("http://fhir.de/CodeSystem/bfarm/atc");
    expect(adminCoding?.[2]).toEqual({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: "1545150",
    });
  });

  it("never invents a BfArM coding when no ATC code is stored, even with germanAtc on", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        medications: [
          {
            id: "med-herbal",
            name: "Herbal mix",
            dose: "1 tab",
            schedules: [],
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
      { germanAtc: true },
    );
    const stmt = bundle.entry
      .map((e) => e.resource)
      .find(
        (r): r is FhirMedicationStatement =>
          r.resourceType === "MedicationStatement",
      );
    // Collapses to the text-only concept exactly as before.
    expect(stmt?.medicationCodeableConcept.coding).toBeUndefined();
    expect(stmt?.medicationCodeableConcept.text).toBe("Herbal mix");
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
      .find((o) => o.code.text === "Mood (average over period)");
    expect(moodObs?.valueQuantity?.value).toBe(3.6);
    // 76542-6 does not exist in LOINC: text-only, and a survey finding, not
    // a vital sign (so the vital-signs panel does not claim it).
    expect(moodObs?.code.coding).toBeUndefined();
    expect(moodObs?.category?.[0]?.coding?.[0]?.code).toBe("survey");
  });

  it("emits no Observation for a type with no readings (empty domain)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {},
        glucoseStats: {},
        compliance: {},
        bmi: null,
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const observations = bundle.entry
      .map((e) => e.resource)
      .filter((r) => r.resourceType === "Observation");
    expect(observations).toHaveLength(0);
  });

  it("maps SpO2 to the iOS-locked LOINC 59408-5 with display + UCUM %", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          OXYGEN_SATURATION: [
            { value: 98, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const spo2 = observationsOf(bundle).find((o) =>
      o.code.coding?.some((c) => c.code === "59408-5"),
    );
    expect(spo2).toBeDefined();
    const coding = spo2?.code.coding?.find((c) => c.code === "59408-5");
    expect(coding?.display).toBe(
      "Oxygen saturation in Arterial blood by Pulse oximetry",
    );
    expect(spo2?.valueQuantity?.code).toBe("%");
  });

  it("maps VO2max to the HealthKit identifier, not the nonexistent LOINC 96402-2", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          VO2_MAX: [{ value: 42, measuredAt: "2026-04-30T08:00:00.000Z" }],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const codings = observationsOf(bundle).flatMap((o) => o.code.coding ?? []);
    expect(codings.some((c) => c.code === "96402-2")).toBe(false);
    const coding = codings.find(
      (c) => c.code === "HKQuantityTypeIdentifierVO2Max",
    );
    expect(coding?.system).toBe(
      "https://healthlog.dev/fhir/CodeSystem/healthkit",
    );
    expect(coding?.display).toBe("VO2 max (estimated)");
  });

  it("emits steps with UCUM {steps}", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          ACTIVITY_STEPS: [
            { value: 8200, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const steps = observationsOf(bundle).find((o) =>
      o.code.coding?.some((c) => c.code === "41950-7"),
    );
    expect(steps?.valueQuantity?.code).toBe("{steps}");
    expect(steps?.valueQuantity?.unit).toBe("{steps}");
  });

  it("emits sleep in HOURS with UCUM h (stored minutes converted)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          // 450 minutes = 7.5 h
          SLEEP_DURATION: [
            { value: 450, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const sleep = observationsOf(bundle).find((o) =>
      o.code.coding?.some((c) => c.code === "93832-4"),
    );
    expect(sleep?.valueQuantity?.code).toBe("h");
    expect(sleep?.valueQuantity?.value).toBe(7.5);
  });

  it("maps body water + bone mass to the LOINC body-composition terms", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          TOTAL_BODY_WATER: [
            { value: 42.3, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
          BONE_MASS: [{ value: 3.1, measuredAt: "2026-04-30T08:00:00.000Z" }],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const water = observationsOf(bundle).find((o) =>
      o.code.coding?.some(
        (c) => c.code === "101683-1" && c.display === "Body water mass",
      ),
    );
    const bone = observationsOf(bundle).find((o) =>
      o.code.coding?.some(
        (c) => c.code === "101685-6" && c.display === "Body bone mass",
      ),
    );
    expect(water?.valueQuantity?.code).toBe("kg");
    expect(bone?.valueQuantity?.code).toBe("kg");
  });

  it("maps the new standard activity/gait metrics", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          ACTIVE_ENERGY_BURNED: [
            { value: 540, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
          WALKING_SPEED: [
            { value: 1.3, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const energy = observationsOf(bundle).find((o) =>
      o.code.coding?.some((c) => c.code === "41981-2"),
    );
    // Not 41957-2 (a 24-hour mean): a HealthKit walking-speed reading.
    const speed = observationsOf(bundle).find((o) =>
      o.code.coding?.some(
        (c) => c.code === "HKQuantityTypeIdentifierWalkingSpeed",
      ),
    );
    expect(energy?.valueQuantity?.code).toBe("kcal");
    // Walking speed FHIR value stays m/s (no km/h conversion).
    expect(speed?.valueQuantity?.code).toBe("m/s");
    expect(speed?.valueQuantity?.value).toBe(1.3);
  });

  it("emits HK-placeholder codes as the HealthKit identifier string", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          AUDIO_EXPOSURE_ENV: [
            { value: 72, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
          FLIGHTS_CLIMBED: [
            { value: 12, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const audio = observationsOf(bundle).find((o) =>
      o.code.coding?.some(
        (c) => c.code === "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
      ),
    );
    const flights = observationsOf(bundle).find((o) =>
      o.code.coding?.some(
        (c) => c.code === "HKQuantityTypeIdentifierFlightsClimbed",
      ),
    );
    // `dB[A]` is a readable label, not a UCUM expression — it stays on the
    // display `unit` and is never stamped as a coded UCUM symbol.
    expect(audio?.valueQuantity?.unit).toBe("dB[A]");
    expect(audio?.valueQuantity?.code).toBeUndefined();
    expect(audio?.valueQuantity?.system).toBeUndefined();
    expect(flights?.valueQuantity?.code).toBe("{flights}");
  });

  it("routes HealthKit placeholder codes onto the custom CodeSystem, never LOINC", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {
          WEIGHT: [{ value: 80, measuredAt: "2026-04-30T08:00:00.000Z" }],
          FLIGHTS_CLIMBED: [
            { value: 12, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const codings = observationsOf(bundle).flatMap((o) => o.code.coding ?? []);

    // A real LOINC metric keeps the LOINC namespace.
    const weight = codings.find((c) => c.code === "29463-7");
    expect(weight?.system).toBe("http://loinc.org");

    // The HealthKit placeholder moves to the shared custom CodeSystem with the
    // raw HK identifier as the code (byte-aligned with the iOS exporter).
    const flightsCoding = codings.find(
      (c) => c.code === "HKQuantityTypeIdentifierFlightsClimbed",
    );
    expect(flightsCoding?.system).toBe(
      "https://healthlog.dev/fhir/CodeSystem/healthkit",
    );

    // Conformance invariant: no HealthKit identifier is ever emitted under the
    // LOINC namespace anywhere in the bundle.
    const hkUnderLoinc = codings.filter(
      (c) =>
        c.system === "http://loinc.org" &&
        c.code?.startsWith("HKQuantityTypeIdentifier"),
    );
    expect(hkUnderLoinc).toHaveLength(0);
  });

  it("discriminates glucose LOINC by context (random/fasting/afterMeal)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        glucoseStats: {
          RANDOM: { avg: 110, min: 90, max: 140, count: 3, latest: 110 },
          FASTING: { avg: 92, min: 85, max: 100, count: 4, latest: 90 },
          POSTPRANDIAL: { avg: 130, min: 120, max: 160, count: 2, latest: 132 },
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const codes = observationsOf(bundle)
      .flatMap((o) => o.code.coding ?? [])
      .map((c) => c.code);
    expect(codes).toContain("2339-0"); // random
    expect(codes).toContain("1558-6"); // fasting
    expect(codes).toContain("1521-4"); // afterMeal / postprandial
  });

  it("emits BMI exactly once (computed block, no stored-series duplicate)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        bmi: 24.1,
        measurements: {
          BODY_MASS_INDEX: [
            { value: 23.9, measuredAt: "2026-04-30T08:00:00.000Z" },
          ],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const bmiObs = observationsOf(bundle).filter((o) =>
      o.code.coding?.some((c) => c.code === "39156-5"),
    );
    expect(bmiObs).toHaveLength(1);
    // The computed BMI (24.1) wins, not the stored series (23.9).
    expect(bmiObs[0].valueQuantity?.value).toBe(24.1);
    expect(bmiObs[0].code.coding?.[0].display).toBe(
      "Body mass index (BMI) [Ratio]",
    );
  });

  it("emits no DiagnosticReport, and no empty array anywhere, when the window holds no vital sign", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ measurements: {}, bmi: null }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const types = bundle.entry.map((e) => e.resource.resourceType);
    expect(types).not.toContain("DiagnosticReport");
    const composition = bundle.entry[0].resource as FhirComposition;
    const refs = (composition.section ?? []).flatMap((s) => s.entry ?? []);
    for (const ref of refs) {
      expect(refTarget(bundle, ref.reference)).not.toMatch(
        /^DiagnosticReport\//,
      );
    }
    // R4: an array element is absent, never empty.
    const emptyArrays: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        if (value.length === 0) emptyArrays.push(path);
        value.forEach((item, i) => walk(item, `${path}[${i}]`));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(bundle, "Bundle");
    expect(emptyArrays).toEqual([]);
  });

  it("leaves the vital-signs section without `entry` when it has nothing to list", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        measurements: {},
        bmi: null,
        glucoseStats: {},
        compliance: {},
        medications: [],
        mood: null,
        labResults: [],
      } as Partial<DoctorReportData>),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const composition = bundle.entry[0].resource as FhirComposition;
    const vitals = composition.section?.find((s) => s.title === "Vital signs");
    expect(vitals?.text?.div).toBeTruthy();
    expect(
      vitals && "entry" in vitals ? vitals.entry : undefined,
    ).toBeUndefined();
  });

  it("appends a DiagnosticReport as the LAST entry routing all Observation refs", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const last = bundle.entry[bundle.entry.length - 1].resource;
    expect(last.resourceType).toBe("DiagnosticReport");
    const report = last as FhirDiagnosticReport;
    expect(report.code.coding?.[0].code).toBe("85353-1");
    expect(report.effectivePeriod?.start).toBe("2026-02-02T00:00:00.000Z");
    expect(report.effectivePeriod?.end).toBe("2026-05-03T12:00:00.000Z");
    // A vital-signs panel reports vital signs, not labs / adherence / surveys.
    const vitals = observationsOf(bundle).filter((o) =>
      (o.category ?? []).some((c) =>
        (c.coding ?? []).some((coding) => coding.code === "vital-signs"),
      ),
    );
    expect(vitals.length).toBeGreaterThan(0);
    expect(vitals.length).toBeLessThan(observationsOf(bundle).length);
    expect(report.result).toHaveLength(vitals.length);
    const referenced = (report.result ?? []).map((r) =>
      refTarget(bundle, r.reference),
    );
    expect(referenced).toEqual(vitals.map((o) => `Observation/${o.id}`));
  });

  it("uses 'Vital signs' + 'Medications' Composition sections", () => {
    const bundle = buildFhirDocumentBundle(
      makeData(),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const composition = bundle.entry[0].resource;
    expect(composition.resourceType).toBe("Composition");
    const titles =
      composition.resourceType === "Composition"
        ? (composition.section ?? []).map((s) => s.title)
        : [];
    expect(titles).toContain("Vital signs");
    expect(titles).toContain("Medications");
    expect(titles).not.toContain("Patient");
    expect(titles).not.toContain("Observations");
  });
  it("emits the selected anamnesis facts and matching section narrative", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        anamnesis: {
          conditions: "Asthma & eczema",
          conditionsUnreadable: false,
          smokingStatus: "CURRENT",
          alcoholPattern: "WEEKLY",
          shiftSchedule: "ROTATING",
          unreadableFacts: [],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const facts = observationsOf(bundle).filter((observation) =>
      observation.id.startsWith("obs-anamnesis-"),
    );
    expect(facts).toHaveLength(3);
    expect(facts.map((fact) => fact.code.coding?.[0]?.code)).toEqual([
      "72166-2",
      "11331-6",
      "74159-5",
    ]);
    expect(facts.map((fact) => fact.valueCodeableConcept?.text)).toEqual([
      "Current smoker",
      "Weekly",
      "Rotating shifts",
    ]);

    const composition = bundle.entry[0].resource;
    expect(composition.resourceType).toBe("Composition");
    if (composition.resourceType !== "Composition") return;
    const section = composition.section?.find(
      (candidate) => candidate.title === "Anamnesis",
    );
    expect(
      section?.entry?.map((ref) => refTarget(bundle, ref.reference)),
    ).toEqual(facts.map((fact) => `Observation/${fact.id}`));
    expect(section?.text?.div).toContain("Asthma &amp; eczema");
    expect(section?.text?.div).toContain("Current smoker");
    expect(section?.text?.div).toContain("Weekly");
    expect(section?.text?.div).toContain("Rotating shift");
  });

  it("preserves not-recorded and unreadable anamnesis values distinctly", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        anamnesis: {
          conditions: null,
          conditionsUnreadable: true,
          smokingStatus: null,
          alcoholPattern: null,
          shiftSchedule: null,
          unreadableFacts: ["ALCOHOL_PATTERN"],
        },
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const facts = observationsOf(bundle).filter((observation) =>
      observation.id.startsWith("obs-anamnesis-"),
    );
    expect(
      facts.map((fact) => fact.dataAbsentReason?.coding?.[0]?.code),
    ).toEqual(["unknown", "error", "unknown"]);

    const composition = bundle.entry[0].resource;
    expect(composition.resourceType).toBe("Composition");
    if (composition.resourceType !== "Composition") return;
    const narrative = composition.section?.find(
      (candidate) => candidate.title === "Anamnesis",
    )?.text?.div;
    expect(narrative).toContain("Conditions: unreadable");
    expect(narrative).toContain("Smoking status: not recorded");
    expect(narrative).toContain("Alcohol pattern: unreadable");
    expect(narrative).toContain("Shift schedule: not recorded");
  });

  it("omits anamnesis resources and section when the leaf was not selected", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ anamnesis: null }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    expect(
      observationsOf(bundle).filter((observation) =>
        observation.id.startsWith("obs-anamnesis-"),
      ),
    ).toEqual([]);
    const composition = bundle.entry[0].resource;
    expect(composition.resourceType).toBe("Composition");
    if (composition.resourceType !== "Composition") return;
    expect(
      composition.section?.some((section) => section.title === "Anamnesis"),
    ).toBe(false);
  });
});

describe("buildFhirDocumentBundle — illness episodes (v1.18.1 P4)", () => {
  function conditionsOf(bundle: ReturnType<typeof buildFhirDocumentBundle>) {
    return bundle.entry
      .map((e) => e.resource)
      .filter((r) => r.resourceType === "Condition");
  }
  function encountersOf(bundle: ReturnType<typeof buildFhirDocumentBundle>) {
    return bundle.entry
      .map((e) => e.resource)
      .filter((r) => r.resourceType === "Encounter");
  }

  it("emits no Condition / Encounter when there are no episodes", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ illnessEpisodes: null }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    expect(conditionsOf(bundle)).toHaveLength(0);
    expect(encountersOf(bundle)).toHaveLength(0);
    const composition = bundle.entry[0].resource;
    const titles =
      composition.resourceType === "Composition"
        ? (composition.section ?? []).map((s) => s.title)
        : [];
    expect(titles).not.toContain("Conditions");
  });

  it("maps a resolved episode to a Condition (resolved) + finished Encounter", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        illnessEpisodes: [
          {
            label: "Erkältung",
            type: "INFECTION",
            lifecycle: "ACUTE",
            onsetAt: "2026-04-01T00:00:00.000Z",
            resolvedAt: "2026-04-10T00:00:00.000Z",
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const conditions = conditionsOf(bundle);
    expect(conditions).toHaveLength(1);
    const c = conditions[0];
    if (c.resourceType !== "Condition") throw new Error("not a Condition");
    // The user's label rides code.text; the code is the BROAD SNOMED category
    // for the type (INFECTION → 40733004 "Infectious disease"), never a
    // fabricated specific diagnosis.
    expect(c.code.text).toBe("Erkältung");
    expect(c.code.coding?.[0].code).toBe("40733004");
    expect(c.onsetDateTime).toBe("2026-04-01T00:00:00.000Z");
    expect(c.abatementDateTime).toBe("2026-04-10T00:00:00.000Z");
    expect(c.clinicalStatus?.coding?.[0].code).toBe("resolved");
    // Patient-reported, not clinician-confirmed.
    expect(c.verificationStatus?.coding?.[0].code).toBe("unconfirmed");

    const encounters = encountersOf(bundle);
    expect(encounters).toHaveLength(1);
    const enc = encounters[0];
    if (enc.resourceType !== "Encounter") throw new Error("not an Encounter");
    expect(enc.status).toBe("finished");
    expect(enc.period?.start).toBe("2026-04-01T00:00:00.000Z");
    expect(enc.period?.end).toBe("2026-04-10T00:00:00.000Z");
    expect(refTarget(bundle, enc.reasonReference?.[0].reference)).toBe(
      `Condition/${c.id}`,
    );

    const composition = bundle.entry[0].resource;
    const titles =
      composition.resourceType === "Composition"
        ? (composition.section ?? []).map((s) => s.title)
        : [];
    expect(titles).toContain("Conditions");
  });

  it("maps an ongoing episode to active Condition + in-progress Encounter (no abatement)", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        illnessEpisodes: [
          {
            label: "Long-COVID",
            type: "CHRONIC",
            lifecycle: "CHRONIC_ONGOING",
            onsetAt: "2026-03-01T00:00:00.000Z",
            resolvedAt: null,
          },
        ],
      }),
      { insuranceNumber: null },
      FIXED_NOW,
    );
    const c = conditionsOf(bundle)[0];
    if (c.resourceType !== "Condition") throw new Error("not a Condition");
    expect(c.clinicalStatus?.coding?.[0].code).toBe("active");
    // CHRONIC → 27624003 "Chronic disease" (broad category, not a diagnosis).
    expect(c.code.coding?.[0].code).toBe("27624003");
    expect(c.abatementDateTime).toBeUndefined();
    const enc = encountersOf(bundle)[0];
    if (enc.resourceType !== "Encounter") throw new Error("not an Encounter");
    expect(enc.status).toBe("in-progress");
    expect(enc.period?.end).toBeUndefined();
  });
});
