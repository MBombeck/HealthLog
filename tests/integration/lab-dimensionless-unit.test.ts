/**
 * A lab value without a unit, through the CSV import against a real database.
 *
 * `1` in the unit column is the explicit "no unit" choice (the UCUM unity): it
 * mints a marker kept in "1" and stores the reading under it. An empty unit
 * cell is still refused, and "1" stays a unit of its own in both directions:
 * it does not go under a marker kept in mg/dL, and mg/dL does not go under it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { textToStream } from "@/lib/import/csv-stream";
import { importLabsCsv } from "@/lib/import/labs-csv";
import { labsCsvQuerySchema } from "@/lib/validations/record-import";

const prisma = getPrismaClient();
const USER = "unitless-lab-user";
const TZ = "Europe/Berlin";

const query = labsCsvQuerySchema.parse({
  analyte: "0",
  value: "1",
  unit: "2",
  date: "3",
  referenceRange: "4",
  decimal: "comma",
  dateOrder: "dmy",
});

function run(csv: string) {
  return importLabsCsv({
    userId: USER,
    tz: TZ,
    stream: textToStream(csv),
    maxBytes: 1_000_000,
    query,
  });
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: TZ },
  });
  await prisma.biomarker.create({
    data: { userId: USER, name: "LDL", unit: "mg/dL" },
  });
});

describe("lab CSV import of a value without a unit", () => {
  it("mints a marker without a unit and refuses the rows that are not one", async () => {
    const result = await run(
      [
        "Analyt;Wert;Einheit;Datum;Referenz",
        "Cholesterin/HDL-Quotient;3,6;1;01.03.2025;0 - 5",
        "INR;1,1;;01.03.2025;",
        "LDL;2,1;1;01.03.2025;",
      ].join("\n"),
    );
    expect(result.errors).toEqual([
      { line: 3, reason: "missing_unit", field: "unit" },
      { line: 4, reason: "unit_mismatch", field: "unit" },
    ]);
    expect(result.inserted).toBe(1);

    const marker = await prisma.biomarker.findFirstOrThrow({
      where: { userId: USER, name: "Cholesterin/HDL-Quotient" },
    });
    expect(marker.unit).toBe("1");
    const reading = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER, biomarkerId: marker.id },
    });
    expect(reading.unit).toBe("1");
    expect(reading.value).toBe(3.6);
    expect(reading.sourceUnit).toBeNull();
    expect(reading.sourceReferenceHigh).toBe(5);
  });

  it("refuses a real unit under the marker without one", async () => {
    // A marker of its own, kept in "1", rather than the one the case above
    // mints: the cases run in either order.
    await prisma.biomarker.create({
      data: { userId: USER, name: "LDL/HDL-Quotient", unit: "1" },
    });
    const result = await run(
      [
        "Analyt;Wert;Einheit;Datum",
        "LDL/HDL-Quotient;3,4;mg/dL;02.03.2025",
        "LDL/HDL-Quotient;3,2;1;03.03.2025",
      ].join("\n"),
    );
    expect(result.errors).toEqual([
      { line: 2, reason: "unit_mismatch", field: "unit" },
    ]);
    expect(result.inserted).toBe(1);
  });
});
