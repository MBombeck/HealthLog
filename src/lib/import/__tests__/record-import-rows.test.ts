/**
 * Row normalisation of the lab and medication CSV imports (#1215): what a
 * cell may mean, and the reason a row is refused when it could mean two
 * things. Pure; the database half is in
 * `tests/integration/record-csv-import.test.ts`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createMedicationSchema } from "@/lib/validations/medication";
import {
  labsCsvQuerySchema,
  medicationsCsvQuerySchema,
} from "@/lib/validations/record-import";

import { normaliseLabRow, readingKeys } from "../labs-csv";
import {
  medicationCreateBody,
  normaliseMedicationRow,
  parseTimes,
} from "../medications-csv";

const NOW = new Date("2026-10-21T10:00:00.000Z");
const labQuery = (extra: Record<string, string> = {}) =>
  labsCsvQuerySchema.parse({
    analyte: "0",
    value: "1",
    unit: "2",
    date: "3",
    referenceRange: "4",
    ...extra,
  });
const lab = (fields: string[], extra?: Record<string, string>) =>
  normaliseLabRow({ line: 7, fields }, labQuery(extra), "Europe/Berlin", NOW);

describe("lab rows", () => {
  it("reads a numeric result with its unit, date and printed range", () => {
    const r = lab(["HbA1c", "5.4", "%", "2025-03-01", "4.0-5.6"]);
    expect(r).toMatchObject({
      ok: true,
      row: {
        line: 7,
        analyte: "HbA1c",
        value: 5.4,
        valueText: null,
        unit: "%",
        sourceReferenceLow: 4,
        sourceReferenceHigh: 5.6,
      },
    });
    expect(r.ok && r.row.takenAt.toISOString()).toBe(
      "2025-03-01T12:00:00.000Z",
    );
  });

  it("reads a German file: decimal comma, day-first dates, comma ranges", () => {
    const r = lab(["Kreatinin", "0,92", "mg/dl", "01.03.2025", "0,7 - 1,2"], {
      decimal: "comma",
      dateOrder: "dmy",
    });
    expect(r).toMatchObject({
      ok: true,
      row: { value: 0.92, sourceReferenceLow: 0.7, sourceReferenceHigh: 1.2 },
    });
  });

  it("reads 1 in the unit column as a value without a unit", () => {
    expect(lab(["INR", "1.1", "1", "2025-03-01", "0.8-1.2"])).toMatchObject({
      ok: true,
      row: { value: 1.1, unit: "1", sourceReferenceHigh: 1.2 },
    });
  });

  it("still refuses a number whose unit cell is empty", () => {
    for (const unit of ["", "  "]) {
      expect(lab(["INR", "1.1", unit, "2025-03-01", ""])).toEqual({
        ok: false,
        reason: "missing_unit",
        field: "unit",
      });
    }
  });

  it("keeps any other spelling of no unit as the text it is", () => {
    // Only the UCUM unity means "no unit"; a word or a dash stays the literal
    // unit the file wrote, so a marker that already holds it keeps matching.
    for (const unit of ["ratio", "-", "none"]) {
      expect(lab(["A/G", "1.4", unit, "2025-03-01", ""])).toMatchObject({
        ok: true,
        row: { unit },
      });
    }
  });

  it("keeps a non-numeric result as a qualitative reading", () => {
    expect(
      lab(["Urine protein", "negative", "", "2025-03-01", ""]),
    ).toMatchObject({
      ok: true,
      row: { value: null, valueText: "negative", unit: null },
    });
    expect(lab(["PSA", "<0.1", "ng/mL", "2025-03-01", ""])).toMatchObject({
      ok: true,
      row: { valueText: "<0.1" },
    });
  });

  it.each([
    [["", "5", "%", "2025-03-01", ""], "missing_value", "analyte"],
    [["HbA1c", "", "%", "2025-03-01", ""], "missing_value", "value"],
    [["HbA1c", "5.4", "", "2025-03-01", ""], "missing_unit", "unit"],
    [
      ["Glucose", "1,234", "mg/dL", "2025-03-01", ""],
      "ambiguous_number",
      "value",
    ],
    [
      ["Glucose", "1.2.3", "mg/dL", "2025-03-01", ""],
      "invalid_number",
      "value",
    ],
    [["Glucose", "90", "mg/dL", "03/01/25", ""], "invalid_date", "date"],
    [["Glucose", "90", "mg/dL", "2027-01-01", ""], "future_date", "date"],
  ] as const)("refuses %j with %s on %s", (fields, reason, field) => {
    expect(lab([...fields])).toEqual({ ok: false, reason, field });
  });

  it("refuses a range whose low lies above its high", () => {
    expect(
      lab(["Glucose", "90", "mg/dL", "2025-03-01", "", "120", "70"], {
        referenceRange: "4",
        referenceLow: "5",
        referenceHigh: "6",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid_reference_range",
      field: "referenceRange",
    });
  });

  it("refuses a mapping that feeds two fields from one column", () => {
    expect(
      labsCsvQuerySchema.safeParse({ analyte: "0", value: "0", date: "1" })
        .success,
    ).toBe(false);
  });

  it("keys a reading the way the scan commit's duplicate check does", () => {
    const keys = readingKeys(
      {
        biomarkerId: "bm1",
        analyte: "HbA1c",
        takenAt: new Date("2025-03-01T12:00:00.000Z"),
        value: 39,
        valueText: null,
        sourceValue: 5.7,
        sourceUnit: "%",
      },
      "Europe/Berlin",
    );
    expect(keys).toEqual([
      "bm:bm1|2025-03-01|n:39",
      "bm:bm1|2025-03-01|s:5.7:%",
    ]);
  });
});

const medQuery = (extra: Record<string, string> = {}) =>
  medicationsCsvQuerySchema.parse({
    name: "0",
    dose: "1",
    times: "2",
    asNeeded: "3",
    startsOn: "4",
    endsOn: "5",
    ...extra,
  });
const med = (fields: string[], extra?: Record<string, string>) =>
  normaliseMedicationRow({ line: 3, fields }, medQuery(extra), "Europe/Berlin");

describe("medication rows", () => {
  it.each([
    ["08:00", ["08:00"]],
    ["20:00 8:00", ["08:00", "20:00"]],
    ["8.00; 20.00|12:30", ["08:00", "12:30", "20:00"]],
    ["", []],
  ])("times %j → %j", (raw, expected) => {
    expect(parseTimes(raw)).toEqual(expected);
  });

  it.each(["8", "25:00", "morning", "08:00 x"])("refuses times %j", (raw) => {
    expect(parseTimes(raw)).toBeNull();
  });

  it("reads a daily medication with a course", () => {
    expect(
      med(["Ramipril", "5 mg", "08:00", "", "01.02.2025", ""], {
        dateOrder: "dmy",
      }),
    ).toEqual({
      ok: true,
      row: {
        line: 3,
        name: "Ramipril",
        dose: "5 mg",
        times: ["08:00"],
        asNeeded: false,
        startsOn: "2025-02-01",
        endsOn: null,
      },
    });
  });

  it.each([
    [["", "5 mg", "", "", "", ""], "missing_value", "name"],
    [
      ["Ibuprofen", "400 mg", "08:00", "yes", "", ""],
      "as_needed_with_times",
      "times",
    ],
    [
      ["Ibuprofen", "400 mg", "", "sometimes", "", ""],
      "invalid_yes_no",
      "asNeeded",
    ],
    [
      ["X", "1", "08:00", "", "2025-03-01", "2025-02-01"],
      "end_before_start",
      "endsOn",
    ],
    [["Vitamin D", "1000 IE", "", "", "", ""], "missing_times", "times"],
  ] as const)("refuses %j with %s", (fields, reason, field) => {
    expect(med([...fields])).toEqual({ ok: false, reason, field });
  });

  it("builds a body the create route's own schema accepts, reminders off by default", () => {
    const daily = med(["Ramipril", "5 mg", "08:00 20:00", "", "", ""]);
    const asNeeded = med(["Ibuprofen", "400 mg", "", "ja", "", ""]);
    for (const r of [daily, asNeeded]) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const check = createMedicationSchema.safeParse(
        medicationCreateBody(r.row, false),
      );
      expect(check.success ? [] : check.error.issues).toEqual([]);
    }
    if (daily.ok) {
      expect(medicationCreateBody(daily.row, false)).toMatchObject({
        notificationsEnabled: false,
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "20:00",
            timesOfDay: ["08:00", "20:00"],
          },
        ],
      });
      expect(medicationCreateBody(daily.row, true).notificationsEnabled).toBe(
        true,
      );
    }
    if (asNeeded.ok) {
      expect(
        medicationCreateBody(asNeeded.row, true).notificationsEnabled,
      ).toBe(false);
    }
  });
});

describe("structure", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("writes field by field and never spreads a parsed row", () => {
    for (const file of [
      "src/lib/import/labs-csv.ts",
      "src/lib/import/medications-csv.ts",
    ]) {
      const src = read(file);
      expect(src).not.toMatch(/data:\s*\{\s*\.\.\.(row|parsed|data)\b/);
      expect(src).not.toMatch(/\.\.\.parsed\.data/);
    }
  });

  it("checks every medication row with the create route's schema", () => {
    expect(read("src/lib/import/medications-csv.ts")).toContain(
      "createMedicationSchema.safeParse(",
    );
  });

  it("streams the body instead of reading it whole", () => {
    const src = read("src/lib/import/record-import-route.ts");
    expect(src).toContain("stream: request.body");
    expect(src).not.toMatch(/request\.(text|json|arrayBuffer)\(/);
  });
});
