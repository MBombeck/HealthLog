import { describe, expect, it, vi } from "vitest";

import { readingInMarkerUnit, type ReadingMarker } from "../reading-conversion";

/** A client whose `updateMany` records what the fill wrote. */
function client(current: string | null = null) {
  return {
    biomarker: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ analyteKey: current })),
    },
  } as never;
}

const glucose: ReadingMarker = {
  id: "bm-1",
  name: "Glucose",
  unit: "mg/dL",
  analyteKey: "fasting-glucose",
};

const read = (
  marker: ReadingMarker,
  value: number,
  unit: string | undefined,
  low: number | null = null,
  high: number | null = null,
  c = client(),
) =>
  readingInMarkerUnit(c, {
    marker,
    value,
    unit,
    sourceReferenceLow: low,
    sourceReferenceHigh: high,
  });

describe("a reading in the marker's own unit", () => {
  it("is stored as stated, with its window untouched", async () => {
    expect(await read(glucose, 95, "mg/dL", 70, 100)).toEqual({
      ok: true,
      converted: false,
      value: 95,
      sourceReferenceLow: 70,
      sourceReferenceHigh: 100,
    });
  });

  it("is the same when the unit is spelled another way or not sent", async () => {
    expect(await read(glucose, 95, " mg/DL ")).toMatchObject({
      ok: true,
      converted: false,
      value: 95,
    });
    expect(await read(glucose, 95, undefined)).toMatchObject({
      ok: true,
      converted: false,
      value: 95,
    });
  });

  it("does not touch the database", async () => {
    const c = client();
    await read({ ...glucose, analyteKey: null }, 95, "mg/dL", null, null, c);
    expect(
      (c as never as { biomarker: { updateMany: unknown } }).biomarker
        .updateMany,
    ).not.toHaveBeenCalled();
  });
});

describe("a reading in another unit", () => {
  it("is converted into the marker's unit, keeping what the report printed", async () => {
    const result = await read(glucose, 5.6, "mmol/L");
    expect(result).toMatchObject({
      ok: true,
      converted: true,
      sourceValue: 5.6,
      sourceUnit: "mmol/L",
    });
    if (!result.ok) return;
    expect(result.value).toBeCloseTo(5.6 * 18.0182, 9);
  });

  it("stores full precision and trims the printed unit", async () => {
    const result = await read(glucose, 5.6, "  mmol/L ");
    if (!result.ok || !result.converted) throw new Error("not converted");
    expect(result.sourceUnit).toBe("mmol/L");
    expect(result.value).not.toBe(Math.round(result.value));
  });

  it("moves the report's own window with the value", async () => {
    const result = await read(glucose, 5.6, "mmol/L", 3.9, 5.6);
    if (!result.ok) throw new Error("refused");
    expect(result.sourceReferenceLow).toBeCloseTo(3.9 * 18.0182, 9);
    expect(result.sourceReferenceHigh).toBeCloseTo(5.6 * 18.0182, 9);
    expect(result.sourceReferenceLow!).toBeLessThan(
      result.sourceReferenceHigh!,
    );
  });

  it("leaves an open bound open", async () => {
    const result = await read(glucose, 5, "mmol/L", null, 5.6);
    if (!result.ok) throw new Error("refused");
    expect(result.sourceReferenceLow).toBeNull();
    expect(result.sourceReferenceHigh).toBeCloseTo(5.6 * 18.0182, 9);
  });

  it("converts an affine pair: 47.5 mmol/mol is 6.5 % HbA1c", async () => {
    const hba1c: ReadingMarker = {
      id: "bm-2",
      name: "HbA1c",
      unit: "%",
      analyteKey: "hba1c",
    };
    const result = await read(hba1c, 47.5, "mmol/mol", 20, 42);
    if (!result.ok) throw new Error("refused");
    expect(result.value).toBeCloseTo(6.5, 1);
    expect(result.sourceReferenceLow!).toBeLessThan(
      result.sourceReferenceHigh!,
    );
  });

  it("converts by scale alone, for a marker with no analyte", async () => {
    const unknown: ReadingMarker = {
      id: "bm-3",
      name: "Some marker",
      unit: "mg/dL",
      analyteKey: null,
    };
    const result = await read(unknown, 1, "g/L");
    expect(result).toMatchObject({ ok: true, converted: true, value: 100 });
  });
});

describe("the analyte is filled on first use", () => {
  it("links a marker that had no key yet, then converts", async () => {
    const c = client();
    const result = await read(
      { id: "bm-1", name: "Blutzucker", unit: "mg/dL", analyteKey: null },
      5.6,
      "mmol/L",
      null,
      null,
      c,
    );
    expect(result).toMatchObject({ ok: true, converted: true });
    const updateMany = (
      c as never as {
        biomarker: { updateMany: ReturnType<typeof vi.fn> };
      }
    ).biomarker.updateMany;
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "bm-1", analyteKey: null },
      data: { analyteKey: "fasting-glucose" },
    });
  });
});

describe("a refusal", () => {
  it("is returned for a marker with no analyte and a different kind of unit", async () => {
    const free: ReadingMarker = {
      id: "bm-4",
      name: "My own marker",
      unit: "mg/dL",
      analyteKey: null,
    };
    expect(await read(free, 5.6, "mmol/L")).toEqual({
      ok: false,
      reason: "unknown_analyte",
    });
  });

  it("is returned for a pair the analyte's entry does not reach", async () => {
    expect(await read(glucose, 5.6, "%")).toEqual({
      ok: false,
      reason: "unknown_unit",
    });
  });

  it("is returned for a value that is not finite", async () => {
    expect(await read(glucose, Number.NaN, "mmol/L")).toEqual({
      ok: false,
      reason: "not_finite",
    });
  });
});

describe("a marker without a unit", () => {
  const unitless = (): ReadingMarker => ({
    id: "bm-2",
    name: "Haemoglobin",
    unit: "",
  });
  function heldNumbers(count: number) {
    return {
      biomarker: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => null),
      },
      labResult: {
        count: vi.fn(async () => count),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
  }

  it("takes the unit of its first number while it holds none", async () => {
    const c = heldNumbers(0);
    const marker = unitless();
    expect(await read(marker, 140, "g/L", null, null, c as never)).toEqual({
      ok: true,
      converted: false,
      value: 140,
      sourceReferenceLow: null,
      sourceReferenceHigh: null,
    });
    expect(marker.unit).toBe("g/L");
    expect(c.biomarker.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses a number when it already holds numbers, and stamps no unit on them", async () => {
    const c = heldNumbers(1);
    const marker = unitless();
    expect(await read(marker, 140, "g/L", null, null, c as never)).toEqual({
      ok: false,
      reason: "marker_unit_unset",
    });
    expect(marker.unit).toBe("");
    expect(c.biomarker.updateMany).not.toHaveBeenCalled();
    expect(c.labResult.updateMany).not.toHaveBeenCalled();
  });
});
