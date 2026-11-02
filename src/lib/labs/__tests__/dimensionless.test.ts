import { describe, expect, it } from "vitest";

import {
  DIMENSIONLESS_UNIT,
  isDimensionlessUnit,
  labUnitText,
  withLabUnit,
} from "../dimensionless";
import { formatLabReading } from "../format-value";
import { readingInMarkerUnit } from "../reading-conversion";
import { sameLabUnit } from "../unit-normalise";

describe("the dimensionless lab unit", () => {
  it("is the UCUM unity", () => {
    expect(DIMENSIONLESS_UNIT).toBe("1");
  });

  it("recognises only the explicit unity, never an empty unit", () => {
    expect(isDimensionlessUnit("1")).toBe(true);
    expect(isDimensionlessUnit(" 1 ")).toBe(true);
    expect(isDimensionlessUnit("")).toBe(false);
    expect(isDimensionlessUnit(null)).toBe(false);
    expect(isDimensionlessUnit(undefined)).toBe(false);
    expect(isDimensionlessUnit("10")).toBe(false);
    expect(isDimensionlessUnit("1/min")).toBe(false);
  });

  it("renders as nothing beside a value", () => {
    expect(labUnitText("1")).toBe("");
    expect(labUnitText("mg/dL")).toBe("mg/dL");
    expect(labUnitText(null)).toBe("");
    expect(withLabUnit("3.6", "1")).toBe("3.6");
    expect(withLabUnit("3.6", " mg/dL ")).toBe("3.6 mg/dL");
    expect(withLabUnit("3.6", "")).toBe("3.6");
  });

  it("never prints a literal 1 after a reading", () => {
    const text = formatLabReading(
      { value: 3.6, valueText: null, unit: "1" },
      (v) => String(v),
    );
    expect(text).toBe("3.6");
  });

  it("is a unit of its own when compared", () => {
    expect(sameLabUnit("1", "1")).toBe(true);
    expect(sameLabUnit("1", "")).toBe(false);
    expect(sameLabUnit("1", "mg/dL")).toBe(false);
    expect(sameLabUnit("1", "%")).toBe(false);
  });
});

describe("a dimensionless reading against a marker", () => {
  const client = {
    biomarker: { update: async () => ({}) },
  } as unknown as Parameters<typeof readingInMarkerUnit>[0];

  it("is stored as it is under a dimensionless marker", async () => {
    const reading = await readingInMarkerUnit(client, {
      marker: { id: "m1", name: "INR", unit: "1", analyteKey: null },
      value: 1.1,
      unit: "1",
      sourceReferenceLow: 0.8,
      sourceReferenceHigh: 1.2,
    });
    expect(reading).toMatchObject({ ok: true, converted: false, value: 1.1 });
  });

  it("is refused under a marker with a real unit", async () => {
    const reading = await readingInMarkerUnit(client, {
      marker: { id: "m2", name: "LDL", unit: "mg/dL", analyteKey: "ldl" },
      value: 3.6,
      unit: "1",
      sourceReferenceLow: null,
      sourceReferenceHigh: null,
    });
    expect(reading.ok).toBe(false);
  });

  it("refuses a real unit under a dimensionless marker", async () => {
    const reading = await readingInMarkerUnit(client, {
      marker: { id: "m3", name: "INR", unit: "1", analyteKey: null },
      value: 1.1,
      unit: "s",
      sourceReferenceLow: null,
      sourceReferenceHigh: null,
    });
    expect(reading.ok).toBe(false);
  });
});
