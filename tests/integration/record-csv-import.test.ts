/**
 * The lab and medication CSV imports against a real Postgres (#1215).
 *
 *   - a dry run writes nothing (no reading, no marker, no medication) and
 *     reports what the real run then does;
 *   - names resolve to existing markers, new analytes mint one marker each,
 *     a reading in another unit is converted and keeps what the file said;
 *   - re-uploading the same file writes nothing: every row is a duplicate;
 *   - a refused row is reported by line and does not stop the rest;
 *   - medications take a daily schedule, reminders off, as-needed without
 *     schedule, and a dated window opens a course;
 *   - a medication and its category land together or not at all.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { textToStream } from "@/lib/import/csv-stream";
import { importLabsCsv } from "@/lib/import/labs-csv";
import { importMedicationsCsv } from "@/lib/import/medications-csv";
import {
  labsCsvQuerySchema,
  medicationsCsvQuerySchema,
} from "@/lib/validations/record-import";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));
const categoryFault = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/medication-category", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/medication-category")>();
  return {
    ...actual,
    setMedicationCategory: vi.fn(
      async (...args: Parameters<typeof actual.setMedicationCategory>) => {
        if (categoryFault.on) throw new Error("category write failed");
        return actual.setMedicationCategory(...args);
      },
    ),
  };
});

const prisma = getPrismaClient();
const USER = "csv-import-user";
const TZ = "Europe/Berlin";

const LABS = [
  "Analyt;Wert;Einheit;Datum;Referenz",
  "Glucose;5,5;mmol/L;01.03.2025;3,9 - 5,5",
  "Glukose;99;mg/dL;02.03.2025;",
  "HbA1c;5,4;%;01.03.2025;4,0-5,6",
  "Urinstatus Eiweiß;negativ;;01.03.2025;",
  "Ferritin;1.234;ng/mL;01.03.2025;",
  "Ferritin;85;;01.03.2025;",
  "Neuer Marker;12;U/l;03.03.2025;",
].join("\n");

function labsQuery(dryRun: boolean) {
  return labsCsvQuerySchema.parse({
    analyte: "0",
    value: "1",
    unit: "2",
    date: "3",
    referenceRange: "4",
    decimal: "comma",
    dateOrder: "dmy",
    dryRun: dryRun ? "1" : "0",
  });
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: TZ },
  });
  await prisma.biomarker.create({
    // No analyte key stored: the import derives it the way the write does.
    data: { userId: USER, name: "Glucose", unit: "mg/dL" },
  });
  await prisma.biomarkerAlias.create({
    data: {
      userId: USER,
      biomarkerId: (
        await prisma.biomarker.findFirstOrThrow({ where: { userId: USER } })
      ).id,
      name: "Glukose",
      nameFolded: "glukose",
      source: "MANUAL",
    },
  });
});

// One walk: a dry run, the import, the same file again. Each step reads what
// the one before it wrote, so the order holds under a shuffled run.
describe("lab CSV import", { shuffle: false }, () => {
  it("a dry run writes nothing and reports the plan", async () => {
    const result = await importLabsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(LABS, 16),
      maxBytes: 1_000_000,
      query: labsQuery(true),
    });
    expect(result).toMatchObject({
      rows: 7,
      valid: 5,
      inserted: 5,
      failed: 2,
      duplicates: 0,
    });
    expect(result.errors).toEqual([
      { line: 6, reason: "ambiguous_number", field: "value" },
      { line: 7, reason: "missing_unit", field: "unit" },
    ]);
    expect(result.markers?.created.sort()).toEqual([
      "HbA1c",
      "Neuer Marker",
      "Urinstatus Eiweiß",
    ]);
    expect(result.markers?.matched.map((m) => m.how).sort()).toEqual([
      "alias",
      "name",
    ]);
    expect(await prisma.labResult.count({ where: { userId: USER } })).toBe(0);
    expect(await prisma.biomarker.count({ where: { userId: USER } })).toBe(1);
  });

  it("the import converts, mints and keeps what the file said", async () => {
    const result = await importLabsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(LABS, 16),
      maxBytes: 1_000_000,
      query: labsQuery(false),
    });
    expect(result).toMatchObject({ inserted: 5, failed: 2 });
    const glucose = await prisma.labResult.findMany({
      where: { userId: USER, analyte: "Glucose" },
      orderBy: { takenAt: "asc" },
    });
    expect(glucose).toHaveLength(2);
    expect(glucose[0].unit).toBe("mg/dL");
    expect(glucose[0].value).toBeCloseTo(99.1, 0);
    expect(glucose[0].sourceValue).toBe(5.5);
    expect(glucose[0].sourceUnit).toBe("mmol/L");
    expect(glucose[0].source).toBe("IMPORT");
    expect(glucose[1].value).toBe(99);
    const text = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER, valueText: "negativ" },
    });
    expect(text.value).toBeNull();
    expect(await prisma.biomarker.count({ where: { userId: USER } })).toBe(4);
  });

  it("re-uploading the same file writes nothing", async () => {
    const before = await prisma.labResult.count({ where: { userId: USER } });
    const result = await importLabsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(LABS, 7),
      maxBytes: 1_000_000,
      query: labsQuery(false),
    });
    expect(result).toMatchObject({ inserted: 0, duplicates: 5, failed: 2 });
    expect(await prisma.labResult.count({ where: { userId: USER } })).toBe(
      before,
    );
  });

  it("refuses a unit that does not convert into the marker's", async () => {
    const result = await importLabsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(
        "Analyt;Wert;Einheit;Datum\nGlucose;7;mmHg;05.03.2025\n",
      ),
      maxBytes: 1_000_000,
      query: labsCsvQuerySchema.parse({
        analyte: "0",
        value: "1",
        unit: "2",
        date: "3",
        decimal: "comma",
        dateOrder: "dmy",
      }),
    });
    expect(result.errors).toEqual([
      { line: 2, reason: "unit_mismatch", field: "unit" },
    ]);
  });
});

describe("lab CSV import in a zone of the file's own", () => {
  // An account of its own, so its two draws are not in the other cases' counts.
  const ZONE_USER = "csv-import-zone-user";
  beforeAll(async () => {
    await prisma.user.create({
      data: { id: ZONE_USER, username: ZONE_USER, timezone: TZ },
    });
  });

  it("cuts the duplicate day in the zone the file is read in", async () => {
    // Read in New York, these are draws on two days (1 and 2 March). In the
    // account's Berlin they both fall on 2 March, which used to make the
    // second a duplicate of the first.
    const csv = [
      "Analyt;Wert;Einheit;Datum",
      "Zone marker;7;mg/dL;2025-03-01T22:30",
      "Zone marker;7;mg/dL;2025-03-02T02:00",
    ].join("\n");
    const result = await importLabsCsv({
      userId: ZONE_USER,
      tz: TZ,
      stream: textToStream(csv),
      maxBytes: 1_000_000,
      query: labsCsvQuerySchema.parse({
        analyte: "0",
        value: "1",
        unit: "2",
        date: "3",
        timezone: "America/New_York",
      }),
    });
    expect(result).toMatchObject({ inserted: 2, duplicates: 0 });
  });
});

describe("lab CSV import at the row cap", () => {
  const BIG_USER = "csv-import-big-user";
  // 20 000 rows: 40 markers, 500 draw days each, one reading per day.
  const lines = ["Analyt;Wert;Einheit;Datum"];
  for (let i = 0; i < 20_000; i++) {
    const marker = `Marker ${i % 40}`;
    const day = new Date(Date.UTC(2020, 0, 1) + Math.floor(i / 40) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    lines.push(`${marker};${(i % 97) + 1};U/l;${day}`);
  }
  const BIG = lines.join("\n");
  const query = () =>
    labsCsvQuerySchema.parse({
      analyte: "0",
      value: "1",
      unit: "2",
      date: "3",
    });

  /** The file, failing like a dropped connection after `bytes`. */
  function cutAt(bytes: number): ReadableStream<Uint8Array> {
    const all = new TextEncoder().encode(BIG);
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes) {
          controller.error(new Error("connection reset"));
          return;
        }
        controller.enqueue(all.slice(offset, Math.min(offset + 64_000, bytes)));
        offset += 64_000;
      },
    });
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: BIG_USER, username: BIG_USER, timezone: TZ },
    });
  });

  it("an import cut off part way leaves whole chunks, and a retry writes the rest once", async () => {
    let written = 0;
    await expect(
      importLabsCsv({
        userId: BIG_USER,
        tz: TZ,
        stream: cutAt(Math.floor(BIG.length / 3)),
        maxBytes: 16 * 1024 * 1024,
        query: query(),
        onWritten: (n) => {
          written += n;
        },
      }),
    ).rejects.toThrow("connection reset");
    const afterCut = await prisma.labResult.count({
      where: { userId: BIG_USER },
    });
    expect(afterCut).toBe(written);
    expect(afterCut).toBeGreaterThan(0);
    // Whole chunks only: nothing half-written.
    expect(afterCut % 200).toBe(0);

    const started = Date.now();
    const result = await importLabsCsv({
      userId: BIG_USER,
      tz: TZ,
      stream: textToStream(BIG),
      maxBytes: 16 * 1024 * 1024,
      query: query(),
    });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({
      rows: 20_000,
      inserted: 20_000 - afterCut,
      duplicates: afterCut,
      failed: 0,
    });
    expect(await prisma.labResult.count({ where: { userId: BIG_USER } })).toBe(
      20_000,
    );
    expect(await prisma.biomarker.count({ where: { userId: BIG_USER } })).toBe(
      40,
    );
    // Generous: the chunked write takes a few seconds here; the bound only
    // catches a return to one statement per row.
    expect(elapsed).toBeLessThan(120_000);
  }, 300_000);
});

describe("medication CSV import", () => {
  const MEDS = [
    "name,dose,times,as needed,start,end",
    "Ramipril,5 mg,08:00,,2025-01-01,",
    "Metformin,500 mg,08:00 20:00,,,",
    "Ibuprofen,400 mg,,yes,,",
    "Vitamin D,1000 IE,,,,",
    "ramipril,5 MG,08:00,,,",
  ].join("\n");
  const query = (dryRun: boolean) =>
    medicationsCsvQuerySchema.parse({
      name: "0",
      dose: "1",
      times: "2",
      asNeeded: "3",
      startsOn: "4",
      endsOn: "5",
      dryRun: dryRun ? "1" : "0",
    });

  it("checks, then imports, then skips everything on a second upload", async () => {
    const dry = await importMedicationsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(MEDS),
      maxBytes: 100_000,
      query: query(true),
    });
    expect(dry).toMatchObject({
      rows: 5,
      inserted: 3,
      duplicates: 1,
      failed: 1,
    });
    expect(dry.errors).toEqual([
      { line: 5, reason: "missing_times", field: "times" },
      { line: 6, reason: "duplicate" },
    ]);
    expect(await prisma.medication.count({ where: { userId: USER } })).toBe(0);

    const real = await importMedicationsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(MEDS),
      maxBytes: 100_000,
      query: query(false),
    });
    expect(real).toMatchObject({ inserted: 3, duplicates: 1, failed: 1 });
    const meds = await prisma.medication.findMany({
      where: { userId: USER },
      include: { schedules: true, courses: true },
      orderBy: { name: "asc" },
    });
    const byName = new Map(meds.map((m) => [m.name, m]));
    expect(byName.get("Metformin")?.schedules[0]).toMatchObject({
      rrule: "FREQ=DAILY",
      timesOfDay: ["08:00", "20:00"],
    });
    expect(byName.get("Metformin")?.notificationsEnabled).toBe(false);
    expect(byName.get("Ibuprofen")).toMatchObject({ asNeeded: true });
    expect(byName.get("Ibuprofen")?.schedules).toHaveLength(0);
    expect(byName.get("Ramipril")?.courses).toHaveLength(1);

    const again = await importMedicationsCsv({
      userId: USER,
      tz: TZ,
      stream: textToStream(MEDS),
      maxBytes: 100_000,
      query: query(false),
    });
    expect(again).toMatchObject({ inserted: 0, duplicates: 4 });
  });
});

describe("medication CSV import, a crash between medication and category", () => {
  // An account of its own: the medication import case counts every
  // medication its account holds.
  const CRASH_USER = "csv-import-crash-user";
  beforeAll(async () => {
    await prisma.user.create({
      data: { id: CRASH_USER, username: CRASH_USER, timezone: TZ },
    });
  });

  const CSV = ["name,dose,times", "Atorvastatin,20 mg,20:00"].join("\n");
  const query = medicationsCsvQuerySchema.parse({
    name: "0",
    dose: "1",
    times: "2",
    dryRun: "0",
  });

  it("leaves no medication without a category, so the retry writes it whole", async () => {
    categoryFault.on = true;
    await expect(
      importMedicationsCsv({
        userId: CRASH_USER,
        tz: TZ,
        stream: textToStream(CSV),
        maxBytes: 100_000,
        query,
      }),
    ).rejects.toThrow("category write failed");
    categoryFault.on = false;
    expect(
      await prisma.medication.count({
        where: { userId: CRASH_USER, name: "Atorvastatin" },
      }),
    ).toBe(0);

    const retry = await importMedicationsCsv({
      userId: CRASH_USER,
      tz: TZ,
      stream: textToStream(CSV),
      maxBytes: 100_000,
      query,
    });
    expect(retry).toMatchObject({ inserted: 1, duplicates: 0 });
    const med = await prisma.medication.findFirstOrThrow({
      where: { userId: CRASH_USER, name: "Atorvastatin" },
      select: { id: true },
    });
    expect(
      await prisma.medicationCategoryAssignment.count({
        where: { medicationId: med.id },
      }),
    ).toBe(1);
  });
});
