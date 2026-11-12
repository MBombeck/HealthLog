import { describe, it, expect } from "vitest";

import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";

import { buildFhirDocumentBundle } from "../build-bundle";
import { ILLNESS_TYPE_SNOMED } from "../illness-snomed";
import type { FhirCondition } from "../types";

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

function conditionsOf(bundle: ReturnType<typeof buildFhirDocumentBundle>) {
  return bundle.entry
    .map((e) => e.resource)
    .filter((r): r is FhirCondition => r.resourceType === "Condition");
}

function conditionForType(type: string): FhirCondition {
  const bundle = buildFhirDocumentBundle(
    makeData({
      illnessEpisodes: [
        {
          label: `journal-${type}`,
          type,
          lifecycle: "ACUTE",
          onsetAt: "2026-04-01T00:00:00.000Z",
          resolvedAt: null,
        },
      ],
    }),
    { insuranceNumber: null },
    FIXED_NOW,
  );
  return conditionsOf(bundle)[0];
}

describe("illness → SNOMED category coding (v1.18.8)", () => {
  const cases: Array<[string, string, string]> = [
    ["INFECTION", "40733004", "Infectious disease"],
    ["ALLERGY", "473011001", "Allergic condition"],
    ["INJURY", "417163006", "Traumatic or non-traumatic injury"],
    ["MENTAL_HEALTH", "74732009", "Mental disorder"],
    ["AUTOIMMUNE", "85828009", "Autoimmune disease"],
    ["CHRONIC", "27624003", "Chronic disease"],
    ["OTHER", "64572001", "Disease"],
  ];

  it.each(cases)(
    "maps IllnessType %s to SNOMED %s on the Condition",
    (type, code, display) => {
      const c = conditionForType(type);
      expect(c.code.coding?.[0].system).toBe("http://snomed.info/sct");
      expect(c.code.coding?.[0].code).toBe(code);
      expect(c.code.coding?.[0].display).toBe(display);
    },
  );

  it("keeps every map entry as a real, non-empty SNOMED concept id", () => {
    for (const [, { code, display }] of Object.entries(ILLNESS_TYPE_SNOMED)) {
      expect(code).toMatch(/^\d{6,}$/);
      expect(display.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the generic Disease root for an unknown / future type", () => {
    const c = conditionForType("PLANTAR_FASCIITIS_NOT_A_REAL_ENUM");
    expect(c.code.coding?.[0].code).toBe("64572001");
    expect(c.code.coding?.[0].display).toBe("Disease");
  });

  it("keeps the patient-reported guard rails intact on a coded Condition", () => {
    const c = conditionForType("AUTOIMMUNE");
    // The user's own label stays the anchor — never replaced by the category.
    expect(c.code.text).toBe("journal-AUTOIMMUNE");
    // The broad class is also surfaced as the category text.
    expect(c.category?.[0].text).toBe("AUTOIMMUNE");
    // Never a clinician-confirmed diagnosis.
    expect(c.verificationStatus?.coding?.[0].code).toBe("unconfirmed");
    expect(
      c.note?.some((n) =>
        n.text.includes("patient-reported, not a clinical diagnosis"),
      ),
    ).toBe(true);
  });
});
