/**
 * The CSV readers against generated input: whatever a file holds, a reader
 * answers with rows, per-row refusals or a structured error, and does so in
 * time and space bounded by the file.
 *
 * Two readers take a whole body as one string (`splitCsvRows`, under the
 * measurement CSV and the dose-history import) and one streams it
 * (`CsvTokenizer`, under the lab and medication imports). The streaming one
 * was written with a bound per field and per record; the whole-text one was
 * bounded only by the body's byte cap, and sixteen megabytes of line breaks
 * held several gigabytes of heap for most of a minute. The regression case at
 * the end is that file.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CSV_MAX_CELLS_PER_ROW,
  CSV_MAX_ROWS,
  CsvShapeLimitError,
  parseCsvMeasurements,
  splitCsvRows,
} from "../csv-measurements";
import { CsvTokenizer, MAX_COLUMNS, MAX_FIELD_CHARS } from "../csv-stream";
import { normaliseLabRow } from "../labs-csv";
import { normaliseMedicationRow, parseTimes } from "../medications-csv";
import { parseAutoExportCsv } from "@/lib/medications/import/auto-export-parse";
import type {
  LabsCsvQuery,
  MedicationsCsvQuery,
} from "@/lib/validations/record-import";

import { assertProperty } from "../../../../tests/property/fast-check";

const NOW = Date.UTC(2026, 5, 1);

/** Characters CSV gives meaning to, weighted up against plain text. */
const csvChar = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(",", ";", "\t", '"', "\n", "\r", " "),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "0",
      "1",
      "9",
      ".",
      "-",
      "+",
      ":",
      "T",
      "Z",
      "e",
    ),
  },
  {
    weight: 1,
    arbitrary: fc.string({ minLength: 1, maxLength: 1, unit: "grapheme" }),
  },
);
const csvText = fc.array(csvChar, { maxLength: 400 }).map((cs) => cs.join(""));

/** A plausible measurement row with one or more cells broken. */
const measurementCell = fc.oneof(
  fc.constantFrom("WEIGHT", "BLOOD_GLUCOSE", "PULSE", "weight", "", "UNKNOWN"),
  fc.constantFrom("72.5", "-1", "1e309", "NaN", "0x10", "", "1,5", " 80 "),
  fc.constantFrom("kg", "lb", "mg/dL", "mmol/L", "", "°F"),
  fc.constantFrom(
    "2026-05-01T08:00:00Z",
    "2026-05-01T08:00:00",
    "2026-13-45T99:99:99+02:00",
    "1800-01-01T00:00:00Z",
    "9999-12-31T23:59:59Z",
    "",
  ),
  fc.string({ maxLength: 260 }),
);
const measurementCsv = fc
  .array(fc.array(measurementCell, { minLength: 0, maxLength: 9 }), {
    maxLength: 40,
  })
  .map(
    (rows) =>
      "type,value,unit,measuredAt,glucoseContext,notes,externalId\n" +
      rows
        .map((r) =>
          r
            .map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c))
            .join(","),
        )
        .join("\n"),
  );

function elapsed<T>(fn: () => T): { value: T | Error; ms: number } {
  const start = performance.now();
  try {
    return { value: fn(), ms: performance.now() - start };
  } catch (err) {
    return { value: err as Error, ms: performance.now() - start };
  }
}

describe("splitCsvRows", () => {
  it("returns bounded rows or a shape refusal for any text", () => {
    assertProperty(
      fc.property(csvText, (text) => {
        const out = elapsed(() => splitCsvRows(text));
        if (out.value instanceof Error) {
          expect(out.value).toBeInstanceOf(CsvShapeLimitError);
          return;
        }
        expect(out.value.length).toBeLessThanOrEqual(CSV_MAX_ROWS);
        for (const row of out.value) {
          expect(row.length).toBeGreaterThan(0);
          expect(row.length).toBeLessThanOrEqual(CSV_MAX_CELLS_PER_ROW);
          // A blank line never becomes a row.
          expect(row.length === 1 && row[0].trim() === "").toBe(false);
        }
      }),
      500,
    );
  });

  it("never yields more characters than it was given", () => {
    assertProperty(
      fc.property(csvText, (text) => {
        const rows = splitCsvRows(text);
        const chars = rows.reduce(
          (n, r) => n + r.reduce((m, c) => m + c.length, 0),
          0,
        );
        expect(chars).toBeLessThanOrEqual(text.length);
      }),
      300,
    );
  });
});

describe("parseCsvMeasurements", () => {
  it("answers every row with an ok row or a stable reason", () => {
    assertProperty(
      fc.property(fc.oneof(measurementCsv, csvText), (text) => {
        const out = parseCsvMeasurements(text, { now: NOW });
        if (out.fatal) {
          expect(out.rows).toEqual([]);
          expect(out.fatal.message.length).toBeGreaterThan(0);
          return;
        }
        for (const r of out.rows) {
          if (r.status === "ok") {
            expect(Number.isFinite(r.row!.value)).toBe(true);
            expect(Number.isNaN(r.row!.measuredAt.getTime())).toBe(false);
            expect(r.row!.measuredAt.getTime()).toBeLessThanOrEqual(
              NOW + 5 * 60_000,
            );
          } else {
            expect(r.reason).toMatch(/^[a-z_]+$/);
          }
        }
      }),
      300,
    );
  });
});

describe("parseAutoExportCsv", () => {
  it("answers any text with an outcome or a shape refusal", () => {
    assertProperty(
      fc.property(csvText, (text) => {
        try {
          const out = parseAutoExportCsv(text, { now: NOW });
          expect(out).toBeTypeOf("object");
        } catch (err) {
          expect(err).toBeInstanceOf(CsvShapeLimitError);
        }
      }),
      300,
    );
  });
});

describe("CsvTokenizer", () => {
  it("keeps every field and record inside its bounds, however the text is cut", () => {
    assertProperty(
      fc.property(
        csvText,
        fc.array(fc.nat({ max: 50 }), { maxLength: 20 }),
        fc.constantFrom<"auto" | "," | ";" | "\t">("auto", ",", ";", "\t"),
        (text, cuts, delimiter) => {
          const tokenizer = new CsvTokenizer(delimiter);
          const records = [];
          let at = 0;
          for (const cut of cuts) {
            records.push(...tokenizer.push(text.slice(at, at + cut)));
            at += cut;
          }
          records.push(...tokenizer.push(text.slice(at)));
          records.push(...tokenizer.end());
          let lastLine = 0;
          for (const r of records) {
            expect(r.fields.length).toBeLessThanOrEqual(MAX_COLUMNS);
            for (const f of r.fields) {
              expect(f.length).toBeLessThanOrEqual(MAX_FIELD_CHARS);
            }
            expect(r.line).toBeGreaterThan(lastLine);
            lastLine = r.line;
          }
        },
      ),
      300,
    );
  });
});

describe("record CSV rows", () => {
  const labQuery = {
    dryRun: false,
    header: true,
    delimiter: "auto",
    decimal: "dot",
    dateOrder: "iso",
    analyte: 0,
    value: 1,
    unit: 2,
    date: 3,
    time: 4,
    referenceLow: 5,
    referenceHigh: 6,
    referenceRange: 7,
    panel: 8,
    note: 9,
  } as unknown as LabsCsvQuery;
  const medicationQuery = {
    dryRun: false,
    header: true,
    delimiter: "auto",
    decimal: "dot",
    dateOrder: "iso",
    name: 0,
    dose: 1,
    times: 2,
    asNeeded: 3,
    startsOn: 4,
    endsOn: 5,
  } as unknown as MedicationsCsvQuery;

  const fields = fc.array(
    fc.oneof(
      fc.string({ maxLength: 120 }),
      fc.constantFrom(
        "5.4",
        "1,234",
        "<0.5",
        "negative",
        "2026-02-30",
        "08:00 20:00",
        "yes",
        "31.12.2026",
        "4.0-5.6",
      ),
    ),
    { maxLength: 12 },
  );

  it("normalise a lab row to a reading or a refusal naming the field", () => {
    assertProperty(
      fc.property(
        fields,
        fc.constantFrom("iso", "dmy", "mdy"),
        fc.constantFrom("dot", "comma"),
        (f, dateOrder, decimal) => {
          const out = normaliseLabRow(
            { line: 2, fields: f },
            { ...labQuery, dateOrder, decimal } as LabsCsvQuery,
            "Europe/Berlin",
            new Date(NOW),
          );
          if (!out.ok) {
            expect(out.reason).toMatch(/^[a-z_]+$/);
            expect(out.field.length).toBeGreaterThan(0);
          }
        },
      ),
      400,
    );
  });

  it("normalise a medication row to a body or a refusal naming the field", () => {
    assertProperty(
      fc.property(fields, (f) => {
        const out = normaliseMedicationRow(
          { line: 2, fields: f },
          medicationQuery,
          "Europe/Berlin",
        );
        if (!out.ok) {
          expect(out.reason).toMatch(/^[a-z_]+$/);
          expect(out.field.length).toBeGreaterThan(0);
        }
      }),
      400,
    );
  });

  it("read intake times as a list of HH:mm or not at all", () => {
    assertProperty(
      fc.property(fc.string({ maxLength: 80 }), (raw) => {
        const times = parseTimes(raw);
        if (times !== null) {
          for (const t of times) expect(t).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        }
      }),
      400,
    );
  });
});

describe("whole-text CSV of the maximum body size", () => {
  const SIXTEEN_MB = 16 * 1024 * 1024;

  it("refuses sixteen megabytes of line breaks without holding a row per line", () => {
    const text = "type,value,unit,measuredAt\n" + "\n".repeat(SIXTEEN_MB - 40);
    const out = elapsed(() => parseCsvMeasurements(text));
    // Blank lines are not rows: the file has a header and nothing else.
    expect(out.value).toEqual({ rows: [] });
    expect(out.ms).toBeLessThan(5_000);
  });

  it("refuses eight million short rows instead of answering each", () => {
    const text =
      "type,value,unit,measuredAt\n" + "x\n".repeat(SIXTEEN_MB / 2 - 20);
    const out = elapsed(() => parseCsvMeasurements(text));
    expect(out.value).toBeInstanceOf(CsvShapeLimitError);
    expect((out.value as CsvShapeLimitError).limit).toBe("rows");
    expect(out.ms).toBeLessThan(5_000);
  });

  it("refuses a row of sixteen million cells", () => {
    const text = "type,value,unit,measuredAt\n" + ",".repeat(SIXTEEN_MB - 40);
    const out = elapsed(() => splitCsvRows(text));
    expect(out.value).toBeInstanceOf(CsvShapeLimitError);
    expect((out.value as CsvShapeLimitError).limit).toBe("cells");
    expect(out.ms).toBeLessThan(5_000);
  });
});
