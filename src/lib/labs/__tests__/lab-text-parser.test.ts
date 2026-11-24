import { describe, expect, it } from "vitest";

import {
  readLabNumber,
  readLabValues,
  readLineDate,
  type LabTextRow,
} from "../lab-text-parser";

/**
 * The model-free lab reader against synthetic reports in the layouts labs
 * print: German OCR output with column gaps, an English text layer with single
 * spaces and flags, the range before the unit, French, Spanish, Italian and
 * Polish rows, a Russian text layer. Every value is made up.
 */

/** The fields a reviewer sees, for compact assertions. */
function seen(row: LabTextRow) {
  return {
    label: row.label,
    value: row.value,
    valueText: row.valueText,
    unit: row.unit,
    referenceText: row.referenceText,
    referenceLow: row.referenceLow,
    referenceHigh: row.referenceHigh,
  };
}

const GERMAN_OCR = `Labor Beispielstadt - Befundbericht
Geburtsdatum: 01.02.1970
Probeneingang: 03.11.2026

Parameter            Ergebnis     Einheit      Referenzbereich
Natrium              141          mmol/l       135 - 145
Kalium                 4,2        mmol/l       3,5 - 5,1
Kreatinin              1,08   H   mg/dl        0,70 - 1,20
Hämoglobin            14,6        g/dl         13,5 - 17,5
CRP                  <0,5         mg/l         <5,0
Thrombozyten          245         Tsd/pl       150 - 400
Telefon 0234 123456
Seite 1 von 2`;

describe("readLabValues on a German OCR table", () => {
  const reading = readLabValues(GERMAN_OCR, { ocr: true });

  it("reads every table row and nothing else", () => {
    expect(reading.rows.map((r) => r.label)).toEqual([
      "Natrium",
      "Kalium",
      "Kreatinin",
      "Hämoglobin",
      "CRP",
      "Thrombozyten",
    ]);
  });

  it("reads comma decimals, the unit and the printed range", () => {
    expect(seen(reading.rows[1])).toEqual({
      label: "Kalium",
      value: 4.2,
      valueText: null,
      unit: "mmol/l",
      referenceText: "3,5 - 5,1",
      referenceLow: 3.5,
      referenceHigh: 5.1,
    });
  });

  it("drops a printed flag and never turns it into anything", () => {
    const row = reading.rows[2];
    expect(row.value).toBe(1.08);
    expect(row.unit).toBe("mg/dl");
    expect(row.referenceText).toBe("0,70 - 1,20");
    expect(JSON.stringify(row)).not.toMatch(/"H"|high|hoch/u);
  });

  it("keeps a bound below detection as the text it is", () => {
    expect(seen(reading.rows[4])).toMatchObject({
      value: null,
      valueText: "<0,5",
      referenceHigh: 5,
    });
  });

  it("repairs the micro sign OCR reads as p, and sends the row to review", () => {
    const row = reading.rows[5];
    expect(row.unit).toBe("Tsd/µl");
    expect(row.doubts).toContain("unit-repaired");
    expect(row.confidence).toBeLessThan(0.75);
  });

  it("knows the catalog markers and trusts OCR rows less than text rows", () => {
    expect(reading.rows[0].catalogKey).not.toBeNull();
    const asText = readLabValues(GERMAN_OCR).rows[0];
    expect(asText.confidence).toBeGreaterThan(reading.rows[0].confidence);
  });

  it("takes the sample date and skips the birth date", () => {
    expect(reading.reportDate).toBe("2026-11-03");
  });

  it("points each row at its own line in the text", () => {
    for (const row of reading.rows) {
      expect(
        GERMAN_OCR.slice(row.lineOffset, row.lineOffset + row.line.length),
      ).toBe(row.line);
    }
  });
});

describe("readLabValues on other layouts", () => {
  it("reads an English text layer with single spaces and flags", () => {
    const text = `Collected: 2026-10-14
Test Result Flag Units Reference Interval
Glucose 92 mg/dL 65-99
Cholesterol, Total 212 H mg/dL 100-199
eGFR 98 mL/min/1.73 >59
TSH 1.890 uIU/mL 0.450-4.500
WBC 6.1 x10E3/uL 3.4-10.8`;
    const reading = readLabValues(text);
    expect(reading.reportDate).toBe("2026-10-14");
    expect(reading.rows.map(seen)).toEqual([
      expect.objectContaining({ label: "Glucose", value: 92, unit: "mg/dL" }),
      expect.objectContaining({
        label: "Cholesterol, Total",
        value: 212,
        referenceLow: 100,
        referenceHigh: 199,
      }),
      expect.objectContaining({
        label: "eGFR",
        unit: "mL/min/1.73",
        referenceLow: 59,
      }),
      expect.objectContaining({ label: "TSH", value: 1.89 }),
      expect.objectContaining({ label: "WBC", unit: "x10E3/uL" }),
    ]);
    // A dot-decimal document reads 1.890 as the decimal it is.
    expect(reading.rows[3].doubts).not.toContain("ambiguous-number");
  });

  it("reads the range before the unit", () => {
    const [row] = readLabValues("TSH basal   2,31   0,27 - 4,20   mU/l").rows;
    expect(seen(row)).toMatchObject({
      label: "TSH basal",
      value: 2.31,
      unit: "mU/l",
      referenceLow: 0.27,
      referenceHigh: 4.2,
    });
  });

  it("reads French, Spanish, Italian and Polish rows", () => {
    const text = [
      "Cholestérol total ........ 1,85 g/l 1,50 à 2,00",
      "Glucosa 95 mg/dl 70 - 110",
      "Emoglobina 13,9 g/dl 12,0 - 16,0",
      "Kreatynina 0,9 mg/dl 0,6 - 1,1",
    ].join("\n");
    const rows = readLabValues(text).rows;
    expect(rows.map((r) => [r.label, r.value, r.unit])).toEqual([
      ["Cholestérol total", 1.85, "g/l"],
      ["Glucosa", 95, "mg/dl"],
      ["Emoglobina", 13.9, "g/dl"],
      ["Kreatynina", 0.9, "mg/dl"],
    ]);
    expect(rows[0].referenceLow).toBe(1.5);
    expect(rows[0].referenceHigh).toBe(2);
  });

  it("reads a Cyrillic name from a text layer", () => {
    const [row] = readLabValues("Глюкоза 5,4 ммоль/л 3,9 - 6,1").rows ?? [];
    // A unit in Cyrillic is not one this reader knows; the row needs a
    // catalog name then, and is left out rather than guessed.
    expect(row?.unit ?? null).toBeNull();
  });

  it("keeps a text result only for a marker the app knows", () => {
    const rows = readLabValues(
      ["Haemoglobin negative", "Befund negativ", "Glucose not detected"].join(
        "\n",
      ),
    ).rows;
    expect(rows.map((r) => [r.label, r.valueText])).toEqual([
      ["Haemoglobin", "negative"],
      ["Glucose", "not detected"],
    ]);
  });

  it("leaves out numbers that are not readings", () => {
    const rows = readLabValues(
      [
        "Telefon 0234 123456",
        "Auftragsnummer 2026 1234",
        "Seite 1 von 3",
        "Gewicht 80 kg",
        "Probeneingang: 03.11.2026 08:15",
      ].join("\n"),
    ).rows;
    expect(rows).toEqual([]);
  });

  it("reads the left of two tables printed side by side, range intact", () => {
    const [row, ...rest] = readLabValues(
      "Natrium   141   mmol/l   135 - 145        Kalium   4,2   mmol/l   3,5 - 5,1",
      { ocr: true },
    ).rows;
    expect(seen(row)).toMatchObject({
      label: "Natrium",
      referenceText: "135 - 145",
      referenceLow: 135,
      referenceHigh: 145,
    });
    expect(rest).toEqual([]);
  });

  it("reads a repeated table once", () => {
    const line = "Natrium 141 mmol/l 135 - 145";
    expect(readLabValues(`${line}\n\n${line}`).rows).toHaveLength(1);
  });

  it("does not repair units in a text layer", () => {
    // A catalog marker still counts, with no unit and a doubt for review;
    // a name the catalog does not know is left out without its unit.
    const [known] = readLabValues("Thrombozyten 245 Tsd/pl 150 - 400").rows;
    expect(known.unit).toBeNull();
    expect(known.doubts).toContain("no-unit");
    expect(readLabValues("Zellzahl 245 Tsd/pl 150 - 400").rows).toEqual([]);
  });

  it("stops at maxRows", () => {
    const text = Array.from(
      { length: 10 },
      (_, i) => `Analyt${String.fromCharCode(65 + i)} ${i + 1} mg/dl 1 - 20`,
    ).join("\n");
    expect(readLabValues(text, { maxRows: 4 }).rows).toHaveLength(4);
  });
});

describe("readLabNumber", () => {
  it("reads decimals with either mark", () => {
    expect(readLabNumber("4,2", null)).toEqual({
      value: 4.2,
      ambiguous: false,
    });
    expect(readLabNumber("4.2", null)).toEqual({
      value: 4.2,
      ambiguous: false,
    });
    expect(readLabNumber("1.234,5", null)).toEqual({
      value: 1234.5,
      ambiguous: false,
    });
  });

  it("reads three digits after a mark by the document's own mark", () => {
    expect(readLabNumber("150.000", "comma")).toEqual({
      value: 150000,
      ambiguous: false,
    });
    expect(readLabNumber("1,080", "comma")).toEqual({
      value: 1.08,
      ambiguous: false,
    });
    expect(readLabNumber("1.080", null)).toEqual({
      value: 1.08,
      ambiguous: true,
    });
  });

  it("refuses a date or a version string", () => {
    expect(readLabNumber("03.11.2026", null)).toBeNull();
    expect(readLabNumber("1.2.3", null)).toBeNull();
  });
});

describe("readLineDate", () => {
  it("reads day-first and ISO dates", () => {
    expect(readLineDate("Eingang 03.11.2026")).toBe("2026-11-03");
    expect(readLineDate("Date: 2026-11-03")).toBe("2026-11-03");
    expect(readLineDate("Datum 3-11-2026")).toBe("2026-11-03");
  });

  it("reads a slashed date only when its order is certain", () => {
    expect(readLineDate("Collected 14/10/2026")).toBe("2026-10-14");
    expect(readLineDate("Collected 10/14/2026")).toBe("2026-10-14");
    expect(readLineDate("Collected 03/11/2026")).toBeNull();
  });

  it("refuses a day the calendar does not have", () => {
    expect(readLineDate("Datum 31.02.2026")).toBeNull();
  });
});
