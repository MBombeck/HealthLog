import { describe, expect, it } from "vitest";

import type { OcrReviewRow } from "../ocr-review-types";
import { seedReviewRows } from "../ocr-review-types";
import {
  collectRowErrors,
  planSave,
  readingConversion,
  readingUnitBlocked,
  readingUnitDiffers,
  toCommitRow,
  validateReviewRow,
} from "../ocr-review-validation";

function row(overrides: Partial<OcrReviewRow> = {}): OcrReviewRow {
  return {
    key: "LDL-0",
    analyte: "LDL",
    value: 2.4,
    valueText: null,
    unit: "mmol/L",
    referenceLow: 0,
    referenceHigh: 3,
    referenceText: null,
    takenAt: "2026-06-10",
    confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
    biomarkerMatch: "existing",
    markerUnit: "mmol/L",
    markerAnalyteKey: null,
    duplicateOf: null,
    biomarkerId: "bm-ldl",
    matchKind: "name",
    suggestions: [],
    chosenBiomarkerId: null,
    confirmed: true,
    ...overrides,
  };
}

describe("validateReviewRow", () => {
  it.each([
    ["a complete numeric row", {}, {}],
    [
      "a complete qualitative row",
      { value: null, valueText: "negative", unit: null },
      {},
    ],
    ["a missing date", { takenAt: null }, { date: true }],
    ["an unparseable date", { takenAt: "not-a-day" }, { date: true }],
    ["a blank analyte", { analyte: "   " }, { analyte: true }],
    ["a missing value", { value: null }, { value: true }],
    ["a non-finite value", { value: Number.NaN }, { value: true }],
    ["a blank unit", { unit: "  " }, { unit: true }],
    ["a missing unit", { unit: null }, { unit: true }],
    [
      "a blank qualitative result",
      { value: null, valueText: " ", unit: null },
      { valueText: true },
    ],
    // The commit's own bounds, so one over-long field marks its row instead
    // of failing the whole save with a 422.
    [
      "an analyte longer than a reading holds",
      { analyte: "a".repeat(121) },
      { analyteTooLong: true },
    ],
    [
      "a unit longer than a reading holds",
      { unit: "u".repeat(41), markerUnit: null },
      { unitTooLong: true },
    ],
    [
      "a qualitative result longer than a reading holds",
      { value: null, valueText: "n".repeat(121), unit: null },
      { valueTextTooLong: true },
    ],
    [
      "several problems at once",
      { takenAt: null, unit: "", analyte: "" },
      { date: true, unit: true, analyte: true },
    ],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(validateReviewRow(row(overrides))).toEqual(expected);
  });

  it("does not ask a qualitative row for a unit", () => {
    expect(
      validateReviewRow(row({ value: null, valueText: "trace", unit: null })),
    ).toEqual({});
  });
});

describe("toCommitRow agrees with validateReviewRow", () => {
  const cases: Partial<OcrReviewRow>[] = [
    {},
    { takenAt: null },
    { takenAt: "nope" },
    { analyte: "" },
    { value: null },
    { unit: "" },
    { value: null, valueText: "negative", unit: null },
    { value: null, valueText: "", unit: null },
    { analyte: "a".repeat(121) },
    { analyte: "a".repeat(120) },
    { unit: "u".repeat(41) },
    { value: null, valueText: "n".repeat(121), unit: null },
  ];

  it.each(cases)("row %j", (overrides) => {
    const r = row(overrides);
    const blocked = Object.keys(validateReviewRow(r)).length > 0;
    expect(toCommitRow(r) === null).toBe(blocked);
  });

  it("anchors the date at noon UTC", () => {
    expect(toCommitRow(row())?.takenAt).toBe("2026-06-10T12:00:00.000Z");
  });

  it("sends the range printed beside a text result", () => {
    expect(
      toCommitRow(
        row({
          value: null,
          valueText: "SEE NOTE",
          unit: null,
          referenceLow: 10,
          referenceHigh: 20,
          referenceText: "10 - 20",
          biomarkerMatch: "new",
        }),
      ),
    ).toMatchObject({
      valueText: "SEE NOTE",
      referenceLow: 10,
      referenceHigh: 20,
      referenceText: "10 - 20",
    });
  });
});

describe("collectRowErrors", () => {
  it("ignores rows that are not selected", () => {
    const rows = [row({ key: "a", takenAt: null, confirmed: false })];
    expect(collectRowErrors(rows).size).toBe(0);
  });

  it("keys the problems by row", () => {
    const rows = [row({ key: "ok" }), row({ key: "bad", takenAt: null })];
    expect([...collectRowErrors(rows).entries()]).toEqual([
      ["bad", { date: true }],
    ]);
  });
});

describe("planSave", () => {
  it("reports nothing selected only when no row is selected", () => {
    expect(planSave([])).toEqual({ kind: "nothing-selected" });
    expect(planSave([row({ confirmed: false })])).toEqual({
      kind: "nothing-selected",
    });
  });

  it("blocks the whole save when a selected row has no date, even if the others are fine", () => {
    const plan = planSave([
      row({ key: "ok" }),
      row({ key: "bad", takenAt: null }),
    ]);
    expect(plan).toEqual({ kind: "blocked" });
  });

  it("is not reported as 'nothing selected' when the only selected row lacks a date", () => {
    expect(planSave([row({ takenAt: null })]).kind).toBe("blocked");
  });

  it("ignores an unselected invalid row and saves the selected ones", () => {
    const plan = planSave([
      row({ key: "ok" }),
      row({ key: "skipped", takenAt: null, confirmed: false }),
    ]);
    expect(plan.kind).toBe("ready");
    if (plan.kind === "ready") expect(plan.payload).toHaveLength(1);
  });

  it("returns every selected row once all of them are complete", () => {
    const plan = planSave([
      row({ key: "a" }),
      row({ key: "b", analyte: "HDL" }),
    ]);
    expect(plan.kind).toBe("ready");
    if (plan.kind === "ready") {
      expect(plan.payload.map((r) => r.analyte)).toEqual(["LDL", "HDL"]);
    }
  });
});

describe("a reading in another unit than its marker's", () => {
  it.each([
    ["the same unit", { unit: "mmol/L" }, false],
    ["the same unit, spelled differently", { unit: "mmol/l" }, false],
    ["a different unit", { unit: "mg/dL" }, true],
    ["a different magnitude of the same substance", { unit: "µmol/L" }, true],
    ["a new marker (no unit yet)", { unit: "mg/dL", markerUnit: null }, false],
    ["no unit stated", { unit: "", markerUnit: "mmol/L" }, false],
    [
      "a qualitative result",
      { value: null, valueText: "negative", unit: "mg/dL" },
      false,
    ],
  ] as const)("%s → differs: %s", (_name, overrides, differs) => {
    expect(readingUnitDiffers(row(overrides))).toBe(differs);
  });

  it("is a blocking error on the unit field, distinct from a missing unit", () => {
    expect(validateReviewRow(row({ unit: "mg/dL" }))).toEqual({
      unitMismatch: true,
    });
    expect(validateReviewRow(row({ unit: "" }))).toEqual({ unit: true });
  });

  it("cannot be turned into a payload, whatever its other fields say", () => {
    expect(toCommitRow(row({ unit: "mg/dL" }))).toBeNull();
    expect(toCommitRow(row({ unit: "mmol/l" }))?.unit).toBe("mmol/l");
  });

  it("blocks the whole save when it is selected, and not when it is not", () => {
    expect(
      planSave([row({ key: "a" }), row({ key: "b", unit: "mg/dL" })]),
    ).toEqual({ kind: "blocked" });
    const plan = planSave([
      row({ key: "a" }),
      row({ key: "b", unit: "mg/dL", confirmed: false }),
    ]);
    expect(plan.kind).toBe("ready");
    expect(
      collectRowErrors([row({ unit: "mg/dL", confirmed: false })]).size,
    ).toBe(0);
  });

  it("starts unselected on the review screen, like a duplicate, so it is a choice", () => {
    const dto = (unit: string, markerUnit: string | null) => ({
      analyte: "Glucose",
      value: 5.6,
      valueText: null,
      unit,
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      takenAt: "2026-06-10",
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
      biomarkerMatch: "existing" as const,
      markerUnit,
      markerAnalyteKey: null,
      duplicateOf: null,
      biomarkerId: "bm-glucose",
      matchKind: "name" as const,
      suggestions: [],
    });
    const [same, other, fresh] = seedReviewRows(
      [dto("mmol/L", "mmol/L"), dto("mmol/L", "mg/dL"), dto("mmol/L", null)],
      null,
    );
    expect(same.confirmed).toBe(true);
    expect(other.confirmed).toBe(false);
    expect(other.markerUnit).toBe("mg/dL");
    expect(fresh.confirmed).toBe(true);
  });
});

describe("a reading in another unit that can be converted", () => {
  // Glucose stated in mmol/L against a marker kept in mg/dL, and the analyte is
  // known: Save converts it, so nothing blocks and the row starts selected.
  const glucose = (overrides: Partial<OcrReviewRow> = {}) =>
    row({
      analyte: "Glucose",
      value: 5.6,
      unit: "mmol/L",
      markerUnit: "mg/dL",
      markerAnalyteKey: "fasting-glucose",
      ...overrides,
    });

  it("previews what Save will store, beside what the report stated", () => {
    const conversion = readingConversion(glucose());
    expect(conversion).toMatchObject({
      unit: "mg/dL",
      statedValue: 5.6,
      statedUnit: "mmol/L",
    });
    expect(conversion!.value).toBeCloseTo(5.6 * 18.0182, 9);
  });

  it("is not blocked, and not a validation error", () => {
    expect(readingUnitDiffers(glucose())).toBe(true);
    expect(readingUnitBlocked(glucose())).toBe(false);
    expect(validateReviewRow(glucose())).toEqual({});
  });

  it("sends what the report printed, for the server to convert", () => {
    const payload = toCommitRow(glucose());
    expect(payload).toMatchObject({
      analyte: "Glucose",
      value: 5.6,
      unit: "mmol/L",
    });
    expect(planSave([glucose()]).kind).toBe("ready");
  });

  it("starts selected on the review screen", () => {
    const dto = {
      analyte: "Glucose",
      value: 5.6,
      valueText: null,
      unit: "mmol/L",
      referenceLow: null,
      referenceHigh: null,
      referenceText: null,
      takenAt: "2026-06-10",
      confidence: { analyte: 1, value: 1, unit: 1, range: 1 },
      biomarkerMatch: "existing" as const,
      markerUnit: "mg/dL",
      markerAnalyteKey: "fasting-glucose",
      duplicateOf: null,
      biomarkerId: "bm-glucose",
      matchKind: "name" as const,
      suggestions: [],
    };
    const [converts, blocked] = seedReviewRows(
      [dto, { ...dto, markerAnalyteKey: null }],
      null,
    );
    expect(converts.confirmed).toBe(true);
    expect(blocked.confirmed).toBe(false);
  });

  it("stays blocked when the marker has no known analyte, or the pair is not in the registry", () => {
    expect(readingUnitBlocked(glucose({ markerAnalyteKey: null }))).toBe(true);
    expect(readingConversion(glucose({ markerAnalyteKey: null }))).toBeNull();
    expect(validateReviewRow(glucose({ markerAnalyteKey: null }))).toEqual({
      unitMismatch: true,
    });
    // The analyte is known but the unit is not one it reaches.
    expect(readingUnitBlocked(glucose({ unit: "%" }))).toBe(true);
  });

  it("has nothing to preview when the units agree or the row is qualitative", () => {
    expect(readingConversion(glucose({ unit: "mg/dL" }))).toBeNull();
    expect(
      readingConversion(glucose({ value: null, valueText: "negative" })),
    ).toBeNull();
    expect(readingConversion(glucose({ value: null }))).toBeNull();
  });
});
