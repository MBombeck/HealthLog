import { describe, it, expect } from "vitest";

import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";

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

describe("lab-result FHIR Observations", () => {
  const labResults: NonNullable<DoctorReportData["labResults"]> = [
    {
      panel: "Lipid panel",
      analyte: "LDL",
      value: 110,
      valueText: null,
      unit: "mg/dL",
      sourceValue: null,
      referenceLow: null,
      referenceHigh: 116,
      catalogReferenceLow: null,
      catalogReferenceHigh: null,
      sourceReferenceText: null,
      referenceOrigin: "catalog" as const,
      referenceDivergesFromCatalog: false,
      takenAt: "2026-04-20T08:00:00.000Z",
      count: 2,
    },
    {
      panel: null,
      analyte: "HbA1c",
      value: 5.4,
      valueText: null,
      unit: "%",
      sourceValue: null,
      referenceLow: 4,
      referenceHigh: 5.6,
      catalogReferenceLow: null,
      catalogReferenceHigh: null,
      sourceReferenceText: null,
      referenceOrigin: "catalog" as const,
      referenceDivergesFromCatalog: false,
      takenAt: "2026-04-21T08:00:00.000Z",
      count: 1,
    },
  ];

  it("emits one laboratory Observation per lab result", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const labObs = observationsOf(bundle).filter((o) =>
      o.category?.some((c) =>
        c.coding?.some((code) => code.code === "laboratory"),
      ),
    );
    // Two lab observations (no glucose in this fixture).
    expect(labObs).toHaveLength(2);
  });

  it("maps the value, unit, and effective date onto the Observation", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const ldl = observationsOf(bundle).find(
      (o) => o.code.text === "LDL (Lipid panel)",
    );
    expect(ldl).toBeDefined();
    expect(ldl?.valueQuantity?.value).toBe(110);
    expect(ldl?.valueQuantity?.unit).toBe("mg/dL");
    expect(ldl?.effectiveDateTime).toBe("2026-04-20T08:00:00.000Z");
  });

  it("emits a referenceRange with only the high bound when low is null", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const ldl = observationsOf(bundle).find(
      (o) => o.code.text === "LDL (Lipid panel)",
    );
    expect(ldl?.referenceRange).toHaveLength(1);
    expect(ldl?.referenceRange?.[0].high?.value).toBe(116);
    expect(ldl?.referenceRange?.[0].low).toBeUndefined();
  });

  it("emits a referenceRange with both bounds", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const a1c = observationsOf(bundle).find((o) => o.code.text === "HbA1c");
    expect(a1c?.referenceRange?.[0].low?.value).toBe(4);
    expect(a1c?.referenceRange?.[0].high?.value).toBe(5.6);
  });

  it("omits referenceRange entirely when no bounds are present", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({
        labResults: [
          {
            panel: null,
            analyte: "CRP",
            value: 2.1,
            valueText: null,
            unit: "mg/L",
            sourceValue: null,
            referenceLow: null,
            referenceHigh: null,
            catalogReferenceLow: null,
            catalogReferenceHigh: null,
            sourceReferenceText: null,
            referenceOrigin: "catalog" as const,
            referenceDivergesFromCatalog: false,
            takenAt: "2026-04-22T08:00:00.000Z",
            count: 1,
          },
        ],
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const crp = observationsOf(bundle).find((o) => o.code.text === "CRP");
    expect(crp).toBeDefined();
    expect(crp?.referenceRange).toBeUndefined();
  });

  it("states a converted reading's window only in the value's unit", () => {
    // A reading converted from mmol/L: the resolved entry carries the bounds
    // in mg/dL and no text (the printed text is in mmol/L and would disagree
    // with low and high), so the element carries the two bounds alone.
    const bundle = buildFhirDocumentBundle(
      makeData({
        labResults: [
          {
            panel: null,
            analyte: "Glucose",
            value: 100.9,
            valueText: null,
            unit: "mg/dL",
            sourceValue: null,
            referenceLow: 70.27,
            referenceHigh: 99.1,
            catalogReferenceLow: 70,
            catalogReferenceHigh: 100,
            sourceReferenceText: null,
            referenceOrigin: "source" as const,
            referenceDivergesFromCatalog: true,
            takenAt: "2026-04-10T08:00:00.000Z",
            count: 1,
          },
        ],
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const [obs] = observationsOf(bundle).filter((o) =>
      o.category?.some((c) =>
        c.coding?.some((code) => code.code === "laboratory"),
      ),
    );
    expect(obs.referenceRange).toEqual([
      {
        low: expect.objectContaining({ value: 70.27, unit: "mg/dL" }),
        high: expect.objectContaining({ value: 99.1, unit: "mg/dL" }),
      },
    ]);
  });

  it("emits no lab Observations when labResults is null", () => {
    const bundle = buildFhirDocumentBundle(
      makeData({ labResults: null }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    const labObs = observationsOf(bundle).filter((o) =>
      o.category?.some((c) =>
        c.coding?.some((code) => code.code === "laboratory"),
      ),
    );
    expect(labObs).toHaveLength(0);
  });
});

describe("lab-result LOINC + canonical UCUM coding (v1.18.8)", () => {
  function labOf(
    type: string,
    unit: string,
    value = 5.4,
    bounds?: { low: number; high: number },
  ) {
    const bundle = buildFhirDocumentBundle(
      makeData({
        labResults: [
          {
            panel: null,
            analyte: type,
            value,
            valueText: null,
            unit,
            sourceValue: null,
            referenceLow: bounds?.low ?? null,
            referenceHigh: bounds?.high ?? null,
            catalogReferenceLow: null,
            catalogReferenceHigh: null,
            sourceReferenceText: null,
            referenceOrigin: "catalog" as const,
            referenceDivergesFromCatalog: false,
            takenAt: "2026-04-20T08:00:00.000Z",
            count: 1,
          },
        ],
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    return observationsOf(bundle).find((o) => o.code.text?.startsWith(type));
  }

  it("emits a LOINC coding alongside code.text for a mapped analyte", () => {
    const o = labOf("HbA1c", "%");
    expect(o?.code.text).toBe("HbA1c");
    expect(o?.code.coding?.[0].system).toBe("http://loinc.org");
    expect(o?.code.coding?.[0].code).toBe("4548-4");
    expect(o?.code.coding?.[0].display).toContain("Hemoglobin A1c");
  });

  it("stamps the canonical UCUM code when the unit matches", () => {
    const o = labOf("LDL", "mg/dL", 110);
    expect(o?.code.coding?.[0].code).toBe("2089-1");
    expect(o?.valueQuantity?.system).toBe("http://unitsofmeasure.org");
    expect(o?.valueQuantity?.code).toBe("mg/dL");
    expect(o?.valueQuantity?.unit).toBe("mg/dL");
  });

  it("codes a value without a unit as the UCUM unity", () => {
    const o = labOf("Cholesterol/HDL ratio", "1", 3.6);
    expect(o?.valueQuantity).toEqual({
      value: 3.6,
      unit: "1",
      system: "http://unitsofmeasure.org",
      code: "1",
    });
  });

  it("resolves analyte aliases to the same canonical LOINC", () => {
    // "LDL", "LDL-C", "LDL Cholesterol" all fold to 2089-1.
    for (const name of ["LDL-C", "LDL Cholesterol", "ldl_c"]) {
      const o = labOf(name, "mg/dL", 110);
      expect(o?.code.coding?.[0].code).toBe("2089-1");
    }
    // German alias for total cholesterol.
    const chol = labOf("Gesamtcholesterin", "mg/dL", 180);
    expect(chol?.code.coding?.[0].code).toBe("2093-3");
    // German alias for creatinine.
    const krea = labOf("Kreatinin", "mg/dL", 0.9);
    expect(krea?.code.coding?.[0].code).toBe("2160-0");
  });

  it("normalises equivalent unit spellings to the canonical UCUM symbol", () => {
    // "mg/dl" (lower-case L) normalises to canonical "mg/dL".
    const o = labOf("HDL", "mg/dl", 55);
    expect(o?.code.coding?.[0].code).toBe("2085-9");
    expect(o?.valueQuantity?.code).toBe("mg/dL");
    // TSH recorded in mIU/L canonicalises to UCUM m[IU]/L.
    const tsh = labOf("TSH", "mIU/L", 2.1);
    expect(tsh?.code.coding?.[0].code).toBe("3016-3");
    expect(tsh?.valueQuantity?.code).toBe("m[IU]/L");
  });

  it("omits the UCUM code AND its system when the unit does not match the mapped canonical", () => {
    // HbA1c mapped (LOINC present) but recorded in an mmol/mol unit we don't
    // canonicalise → keep the LOINC coding, drop the UCUM code, keep display.
    // The system goes with the code: a valueQuantity naming UCUM without a
    // code claims a coding the bundle does not carry.
    const o = labOf("HbA1c", "mmol/mol", 36);
    expect(o?.code.coding?.[0].code).toBe("4548-4");
    expect(o?.valueQuantity?.code).toBeUndefined();
    expect(o?.valueQuantity?.system).toBeUndefined();
    expect(o?.valueQuantity?.unit).toBe("mmol/mol");
  });

  it("keeps an unmapped analyte text-only with no fabricated coding", () => {
    const o = labOf("Selenium", "ug/L", 95);
    expect(o?.code.text).toBe("Selenium");
    expect(o?.code.coding).toBeUndefined();
    // Display unit stays; no coerced UCUM code is invented, and no code
    // system is named for a code that is not there.
    expect(o?.valueQuantity?.unit).toBe("ug/L");
    expect(o?.valueQuantity?.code).toBeUndefined();
    expect(o?.valueQuantity?.system).toBeUndefined();
  });

  it("keeps system and code together on the reference range bounds too", () => {
    // The bounds are stated in the SAME unit as the value, so an uncoded
    // unit must leave them uncoded as well, on both halves.
    const uncoded = labOf("HbA1c", "mmol/mol", 36, { low: 20, high: 42 });
    expect(uncoded?.referenceRange?.[0].low?.system).toBeUndefined();
    expect(uncoded?.referenceRange?.[0].low?.code).toBeUndefined();
    expect(uncoded?.referenceRange?.[0].high?.system).toBeUndefined();
    const coded = labOf("HDL", "mg/dL", 55, { low: 40, high: 60 });
    expect(coded?.referenceRange?.[0].low?.system).toBe(
      "http://unitsofmeasure.org",
    );
    expect(coded?.referenceRange?.[0].low?.code).toBe("mg/dL");
  });
});

describe("qualitative lab-result FHIR Observations (v1.18.9)", () => {
  function qualOf(analyte: string, valueText: string) {
    const bundle = buildFhirDocumentBundle(
      makeData({
        labResults: [
          {
            panel: null,
            analyte,
            value: null,
            valueText,
            unit: "",
            sourceValue: null,
            referenceLow: null,
            referenceHigh: null,
            catalogReferenceLow: null,
            catalogReferenceHigh: null,
            sourceReferenceText: null,
            referenceOrigin: "catalog" as const,
            referenceDivergesFromCatalog: false,
            takenAt: "2026-04-20T08:00:00.000Z",
            count: 1,
          },
        ],
      }),
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
    );
    return observationsOf(bundle).find((o) => o.code.text === analyte);
  }

  it("emits valueCodeableConcept (not valueQuantity) for a negative result", () => {
    const o = qualOf("Hepatitis Bs-Antigen", "negativ");
    expect(o?.valueQuantity).toBeUndefined();
    expect(o?.valueCodeableConcept?.coding?.[0].system).toBe(
      "http://snomed.info/sct",
    );
    expect(o?.valueCodeableConcept?.coding?.[0].code).toBe("260385009");
    expect(o?.valueCodeableConcept?.coding?.[0].display).toBe("Negative");
    // The raw recorded text always rides .text.
    expect(o?.valueCodeableConcept?.text).toBe("negativ");
    // No numeric reference range on a qualitative observation.
    expect(o?.referenceRange).toBeUndefined();
  });

  it("maps a positive (English) result to the Positive SNOMED concept", () => {
    const o = qualOf("HIV Ab", "positive");
    expect(o?.valueCodeableConcept?.coding?.[0].code).toBe("10828004");
    expect(o?.valueCodeableConcept?.text).toBe("positive");
  });

  it("maps 'nicht nachweisbar' to the Not detected SNOMED concept", () => {
    const o = qualOf("HCV RNA", "nicht nachweisbar");
    expect(o?.valueCodeableConcept?.coding?.[0].code).toBe("260415000");
  });

  it("keeps borderline / grenzwertig text-only (no fabricated code)", () => {
    const o = qualOf("Some Serology", "grenzwertig");
    expect(o?.valueCodeableConcept?.coding).toBeUndefined();
    expect(o?.valueCodeableConcept?.text).toBe("grenzwertig");
  });

  it("keeps an unrecognised qualitative term text-only", () => {
    const o = qualOf("Some Serology", "schwach reaktiv");
    expect(o?.valueCodeableConcept?.coding).toBeUndefined();
    expect(o?.valueCodeableConcept?.text).toBe("schwach reaktiv");
    expect(o?.valueQuantity).toBeUndefined();
  });
});
