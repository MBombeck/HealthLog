import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assignPanels,
  fhirInstant,
  mapFhirLabRecord,
  normaliseObservationRef,
  type FhirLabMapping,
} from "../map-observation";

const NOW = new Date("2026-01-01T00:00:00Z");
const SOURCE = {
  sourceURL: "https://fhir.example-health.test/api/FHIR/R4/",
  sourceName: "Example Health",
  fhirVersion: "4.0.1",
};

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"),
  );
}

function map(resource: unknown, extra: Record<string, unknown> = {}) {
  return mapFhirLabRecord({ resource, ...SOURCE, ...extra }, NOW);
}

function reading(result: FhirLabMapping) {
  if (result.kind !== "reading") {
    throw new Error(`expected a reading, got ${result.kind}`);
  }
  return result.reading;
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: "Observation",
    id: "obs-x",
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: "Sodium" },
    effectiveDateTime: "2025-01-01T08:00:00Z",
    valueQuantity: { value: 140, unit: "mmol/L" },
    ...overrides,
  };
}

describe("mapFhirLabRecord — R4", () => {
  it("maps a quantity with its LOINC hint, range and note", () => {
    const r = reading(
      map(fixture("r4-quantity-ldl"), { identifier: "obs-ldl-1" }),
    );
    expect(r.analyte).toBe("LDL Cholesterol (calc)");
    expect(r.loinc).toBe("13457-7");
    expect(r.catalogKey).toBe("ldl");
    expect(r.value).toBe(3.1);
    expect(r.valueText).toBeNull();
    expect(r.unit).toBe("mmol/L");
    expect(r.takenAt.toISOString()).toBe("2025-03-04T07:15:00.000Z");
    expect(r.sourceReferenceLow).toBeNull();
    expect(r.sourceReferenceHigh).toBe(3);
    expect(r.sourceReferenceText).toBe("< 3.0 mmol/L");
    expect(r.note).toBe("Fasting sample.");
    expect(r.panel).toBeNull();
    expect(r.externalId).toMatch(/^fhir:[0-9a-f]{40}$/);
  });

  it("never carries the subject or performer anywhere", () => {
    const serialised = JSON.stringify(map(fixture("r4-quantity-ldl")));
    expect(serialised).not.toContain("Example Patient");
    expect(serialised).not.toContain("example-patient");
    expect(serialised).not.toContain("Example Laboratory");
  });

  it("keeps a comparator result as the printed text, unit included", () => {
    const r = reading(map(fixture("r4-comparator")));
    expect(r.value).toBeNull();
    expect(r.valueText).toBe("<0.5 mg/L");
    expect(r.unit).toBe("mg/L");
    // A text result records no window of its own.
    expect(r.sourceReferenceText).toBeNull();
    expect(r.analyte).toBe(
      "C reactive protein [Mass/volume] in Serum or Plasma",
    );
  });

  it("drops the unity from a comparator text", () => {
    const r = reading(
      map(
        base({ valueQuantity: { value: 1.1, comparator: ">", code: "{INR}" } }),
      ),
    );
    expect(r.valueText).toBe(">1.1");
  });

  it("trims a string result", () => {
    const r = reading(map(fixture("r4-valuestring-positive")));
    expect(r.valueText).toBe("Positive");
    expect(r.value).toBeNull();
    expect(r.unit).toBeNull();
  });

  it("anchors a date alone, and a time without offset, at noon UTC", () => {
    const r = reading(map(fixture("r4-date-only")));
    expect(r.takenAt.toISOString()).toBe("2024-11-20T12:00:00.000Z");
    expect(r.catalogKey).toBe("tsh");
    expect(r.unit).toBe("mIU/L");
    // A text-only range is read.
    expect(r.sourceReferenceLow).toBe(0.4);
    expect(r.sourceReferenceHigh).toBe(4);
    expect(fhirInstant("2024-11-20T08:00:00")?.toISOString()).toBe(
      "2024-11-20T12:00:00.000Z",
    );
    expect(fhirInstant("2024-11")).toBeNull();
    expect(fhirInstant("2024")).toBeNull();
    expect(fhirInstant("2024-02-30")).toBeNull();
  });

  it("falls back through the period start and issued", () => {
    const period = reading(
      map(
        base({
          effectiveDateTime: undefined,
          effectivePeriod: { start: "2025-01-02T09:00:00Z" },
        }),
      ),
    );
    expect(period.takenAt.toISOString()).toBe("2025-01-02T09:00:00.000Z");
    const issued = reading(
      map(
        base({ effectiveDateTime: undefined, issued: "2025-01-03T09:00:00Z" }),
      ),
    );
    expect(issued.takenAt.toISOString()).toBe("2025-01-03T09:00:00.000Z");
  });

  it("keeps an interpretation as text when there is no value", () => {
    const r = reading(map(fixture("r4-no-value-interpretation-pos")));
    expect(r.valueText).toBe("Positive");
  });

  it("maps the panel header to its members' panel", () => {
    const results = (fixture("r4-panel-cbc") as unknown[]).map((r) => map(r));
    expect(results[0]).toMatchObject({ kind: "skip", reason: "panel_header" });
    assignPanels(results);
    expect(reading(results[1]).panel).toBe("Complete blood count");
    expect(reading(results[2]).panel).toBe("Complete blood count");
    expect(reading(results[2]).unit).toBe("10^3/µL");
  });

  it.each([
    ["r4-preliminary", "not_final"],
    ["r4-vital-signs", "not_lab"],
  ])("skips %s as %s", (name, reason) => {
    expect(map(fixture(name))).toMatchObject({ kind: "skip", reason });
  });

  it.each([
    [{ resourceType: "Condition" }, "not_observation"],
    ["not an object", "not_observation"],
    [base({ status: "entered-in-error" }), "withdrawn"],
    [base({ status: "cancelled" }), "withdrawn"],
    [base({ status: "registered" }), "not_final"],
    [base({ status: undefined }), "not_final"],
    [
      base({ valueQuantity: undefined, valueBoolean: true }),
      "unsupported_value",
    ],
    [base({ valueQuantity: undefined, valueRange: {} }), "unsupported_value"],
    [base({ valueQuantity: undefined, component: [] }), "unsupported_value"],
    [
      base({ valueQuantity: undefined, dataAbsentReason: { text: "x" } }),
      "no_value",
    ],
    [base({ valueQuantity: undefined }), "no_value"],
    [base({ code: {} }), "no_value"],
    [base({ effectiveDateTime: undefined }), "no_date"],
    [base({ effectiveDateTime: "2026-01-03T00:00:00Z" }), "future_date"],
    [base({ effectiveDateTime: "1899-12-31" }), "invalid_date"],
  ])("skips %j as %s", (resource, reason) => {
    expect(map(resource)).toMatchObject({ kind: "skip", reason });
  });

  it.each([
    [base({ valueQuantity: { value: 5 } }), "missing_unit"],
    [base({ valueQuantity: undefined, valueInteger: 5 }), "missing_unit"],
    [base({ code: { text: "x".repeat(201) } }), "text_too_long"],
    [
      base({ valueQuantity: undefined, valueString: "y".repeat(201) }),
      "text_too_long",
    ],
  ])("refuses %j as %s", (resource, reason) => {
    expect(map(resource)).toMatchObject({ kind: "fail", reason });
  });

  it("accepts a resource with no category", () => {
    expect(map(base({ category: undefined })).kind).toBe("reading");
  });

  it("keeps a range only in the reading's unit", () => {
    const r = reading(
      map(
        base({
          referenceRange: [
            {
              low: { value: 3.5, unit: "mg/dL" },
              high: { value: 145, unit: "mmol/L" },
            },
          ],
        }),
      ),
    );
    expect(r.sourceReferenceLow).toBeNull();
    expect(r.sourceReferenceHigh).toBe(145);
  });

  it("prefers the general range over an age-specific one, and drops low > high", () => {
    const chosen = reading(
      map(
        base({
          referenceRange: [
            {
              low: { value: 1 },
              high: { value: 2 },
              age: { low: { value: 1 } },
            },
            { low: { value: 135 }, high: { value: 145 } },
          ],
        }),
      ),
    );
    expect([chosen.sourceReferenceLow, chosen.sourceReferenceHigh]).toEqual([
      135, 145,
    ]);
    const inverted = reading(
      map(
        base({ referenceRange: [{ low: { value: 9 }, high: { value: 1 } }] }),
      ),
    );
    expect(inverted.sourceReferenceLow).toBeNull();
    expect(inverted.sourceReferenceHigh).toBeNull();
  });

  it("caps a long note", () => {
    const r = reading(map(base({ note: [{ text: "n".repeat(1500) }] })));
    expect(r.note).toHaveLength(1000);
    expect(r.note?.endsWith("…")).toBe(true);
  });

  it("reads a code display when the code carries no text", () => {
    const r = reading(
      map(
        base({
          code: {
            coding: [
              { system: "http://example.org", display: "Local name" },
              {
                system: "http://loinc.org",
                code: "2951-2",
                display: "Sodium [Moles/volume] in Serum or Plasma",
              },
            ],
          },
        }),
      ),
    );
    expect(r.analyte).toBe("Sodium [Moles/volume] in Serum or Plasma");
    expect(r.loinc).toBe("2951-2");
    expect(r.catalogKey).toBeNull();
  });
});

describe("mapFhirLabRecord — DSTU2", () => {
  it("reads a single category object, comments and a glucose quantity", () => {
    const r = reading(map(fixture("dstu2-quantity-glucose")));
    expect(r.analyte).toBe("Glucose [Mass/volume] in Serum or Plasma");
    expect(r.value).toBe(92);
    expect(r.unit).toBe("mg/dL");
    expect([r.sourceReferenceLow, r.sourceReferenceHigh]).toEqual([70, 99]);
    expect(r.note).toBe("Specimen slightly haemolysed.");
    expect(JSON.stringify(r)).not.toContain("example-patient");
  });

  it("reads a coded value as text", () => {
    expect(reading(map(fixture("dstu2-codeableconcept"))).valueText).toBe(
      "Blood group A",
    );
  });

  it("follows related has-member links only", () => {
    const results = (fixture("dstu2-related-has-member") as unknown[]).map(
      (r) => map(r),
    );
    expect(results[0]).toMatchObject({
      kind: "skip",
      reason: "panel_header",
      memberRefs: ["Observation/dstu2-hdl"],
    });
    assignPanels(results);
    expect(reading(results[1]).panel).toBe("Lipid panel");
    expect(reading(results[1]).catalogKey).toBe("hdl");
  });
});

describe("normaliseObservationRef", () => {
  it.each([
    ["Observation/abc", "Observation/abc"],
    ["https://x.test/fhir/Observation/abc", "Observation/abc"],
    ["https://x.test/fhir/Observation/abc/_history/2", "Observation/abc"],
    ["Patient/abc", null],
    ["", null],
    [42, null],
  ])("%j -> %j", (raw, expected) => {
    expect(normaliseObservationRef(raw)).toBe(expected);
  });
});
