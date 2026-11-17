/**
 * An import's first number gives a text-only marker its unit.
 *
 * A marker minted from a text result ("SEE NOTE", or a qualitative result in
 * an earlier import or an earlier chunk of the same one) has an empty unit.
 * The write itself already let the first number set it, but both imports
 * checked the unit before writing and refused the reading as a unit mismatch
 * against a unit nothing had chosen. The Health Records import and the CSV
 * import, against Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { textToStream } from "@/lib/import/csv-stream";
import { importLabsCsv } from "@/lib/import/labs-csv";
import { writeFhirLabReadings } from "@/lib/labs/fhir-import/write";
import type { MappedFhirLab } from "@/lib/labs/fhir-import/types";
import { labsCsvQuerySchema } from "@/lib/validations/record-import";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const prisma = getPrismaClient();
const USER = "text-marker-import-number-user";

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      timezone: "UTC",
      modulePreferencesJson: { labs: true },
    },
  });
});

async function textOnlyMarker(name: string) {
  const marker = await prisma.biomarker.create({
    data: { userId: USER, name, unit: "" },
  });
  await prisma.labResult.create({
    data: {
      userId: USER,
      biomarkerId: marker.id,
      analyte: name,
      unit: "",
      valueText: "SEE NOTE",
      takenAt: new Date("2026-08-01T12:00:00.000Z"),
    },
  });
  return marker;
}

function reading(over: Partial<MappedFhirLab>): MappedFhirLab {
  return {
    externalId: "fhir:clinic:obs-1",
    analyte: "Ferritin",
    loinc: null,
    catalogKey: null,
    value: 85,
    valueText: null,
    unit: "ng/mL",
    takenAt: new Date("2026-09-01T07:00:00.000Z"),
    sourceReferenceLow: 30,
    sourceReferenceHigh: 400,
    sourceReferenceText: null,
    panel: null,
    note: null,
    ...over,
  };
}

describe("Health Records import", () => {
  it("writes the first number under a text-only marker and sets its unit", async () => {
    const marker = await textOnlyMarker("Ferritin");
    const out = await writeFhirLabReadings({
      userId: USER,
      tz: "UTC",
      readings: [reading({})],
      prisma,
    });
    expect(out.statuses).toEqual([{ status: "inserted" }]);
    const after = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(after.unit).toBe("ng/mL");
    expect(
      await prisma.labResult.count({
        where: { biomarkerId: marker.id, value: 85 },
      }),
    ).toBe(1);
  });

  it("still refuses a unit that does not fit a marker holding numbers", async () => {
    const marker = await prisma.biomarker.create({
      data: { userId: USER, name: "Ferritin", unit: "ng/mL" },
    });
    await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: marker.id,
        analyte: "Ferritin",
        unit: "ng/mL",
        value: 50,
        takenAt: new Date("2026-08-01T12:00:00.000Z"),
      },
    });
    const out = await writeFhirLabReadings({
      userId: USER,
      tz: "UTC",
      readings: [reading({ unit: "U/L" })],
      prisma,
    });
    expect(out.statuses).toEqual([
      { status: "failed", reason: "unit_mismatch" },
    ]);
  });
});

describe("CSV import", () => {
  const query = (dryRun = false) =>
    labsCsvQuerySchema.parse({
      analyte: "0",
      value: "1",
      unit: "2",
      date: "3",
      dryRun: dryRun ? "1" : "0",
    });
  const csv = "Analyte;Value;Unit;Date\nFerritin;85;ng/mL;2026-09-01\n";

  it("previews and writes the first number under a text-only marker", async () => {
    const marker = await textOnlyMarker("Ferritin");
    const preview = await importLabsCsv({
      userId: USER,
      tz: "UTC",
      stream: textToStream(csv),
      maxBytes: 1_000_000,
      query: query(true),
    });
    expect(preview.failed).toBe(0);

    const result = await importLabsCsv({
      userId: USER,
      tz: "UTC",
      stream: textToStream(csv),
      maxBytes: 1_000_000,
      query: query(),
    });
    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(1);
    const after = await prisma.biomarker.findUniqueOrThrow({
      where: { id: marker.id },
    });
    expect(after.unit).toBe("ng/mL");
  });
});
