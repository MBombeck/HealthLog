/**
 * Re-importing Health Records lab results the record already holds (#1421).
 *
 * A later export carries the same results the account typed or imported from
 * a CSV earlier, often with the unit spelled another way or a censored result
 * (`<5`) where the record has the number. Against Postgres, through the shared
 * writer the export job and `POST /api/labs/fhir-batch` use:
 *
 *   - a reading already held under a unit the marker does not take is a
 *     duplicate, not a failure; a new one in that unit still fails;
 *   - a censored text result and the stored number it is bounded by are one
 *     reading, in both directions, when both were taken at the same instant
 *     and state the number in the same unit; serial draws on one day stay
 *     two readings;
 *   - a marker with no unit takes the unit of its first number while it
 *     holds none; once it holds numbers stored without a unit, the next one
 *     is refused as `marker_unit_unset` and nothing stored is relabelled;
 *   - `10^9/L` against `10*9/L` or `x10E3/uL`, and `ng/ml (FEU)` against
 *     `ng/mL (FEU)`, write without a refusal;
 *   - migration 0513 soft-deletes the censored copies the old check let in.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { writeFhirLabReadings } from "@/lib/labs/fhir-import/write";
import type { MappedFhirLab } from "@/lib/labs/fhir-import/types";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
let USER = "";

beforeEach(async () => {
  await truncateAllTables(prisma);
  const user = await prisma.user.create({
    data: {
      username: "lab-reimport",
      email: "lab-reimport@example.test",
      timezone: "Europe/Berlin",
      modulePreferencesJson: { labs: true },
    },
  });
  USER = user.id;
});

/** A date-only reading as a typed or CSV row stores it: noon UTC. */
const DAY = new Date("2026-06-10T12:00:00.000Z");
/** The same day's draw as Health Records states it. */
const DRAW = new Date("2026-06-10T06:30:00.000Z");

function reading(n: number, over: Partial<MappedFhirLab> = {}): MappedFhirLab {
  return {
    externalId: `fhir:clinic:obs-${n}`,
    analyte: "Ferritin",
    loinc: null,
    catalogKey: null,
    value: 80,
    valueText: null,
    unit: "ng/mL",
    takenAt: DRAW,
    sourceReferenceLow: null,
    sourceReferenceHigh: null,
    sourceReferenceText: null,
    panel: null,
    note: null,
    ...over,
  };
}

async function marker(name: string, unit: string) {
  return prisma.biomarker.create({ data: { userId: USER, name, unit } });
}

async function stored(
  biomarkerId: string,
  name: string,
  value: { value?: number; valueText?: string },
  unit: string,
  extra: {
    source?: string;
    createdAt?: Date;
    externalId?: string;
    takenAt?: Date;
  } = {},
) {
  return prisma.labResult.create({
    data: {
      userId: USER,
      biomarkerId,
      analyte: name,
      value: value.value ?? null,
      valueText: value.valueText ?? null,
      unit,
      takenAt: extra.takenAt ?? DAY,
      source: extra.source ?? "MANUAL",
      externalId: extra.externalId ?? null,
      createdAt: extra.createdAt,
    },
  });
}

const write = (readings: MappedFhirLab[]) =>
  writeFhirLabReadings({ userId: USER, tz: "Europe/Berlin", readings, prisma });

describe("a reading the record already holds", () => {
  it("counts as a duplicate even when its unit does not fit the marker", async () => {
    const ferritin = await marker("Ferritin", "ng/mL");
    await stored(ferritin.id, "Ferritin", { value: 80 }, "ng/mL");
    const result = await write([
      reading(1, { unit: "pmol/L" }),
      reading(2, { unit: "pmol/L", value: 81 }),
    ]);
    expect(result.statuses).toEqual([
      { status: "duplicate" },
      { status: "failed", reason: "unit_mismatch" },
    ]);
  });

  it("matches a censored text result against the stored number", async () => {
    const crp = await marker("CRP", "mg/L");
    await stored(crp.id, "CRP", { value: 5 }, "mg/L", { takenAt: DRAW });
    const result = await write([
      reading(1, {
        analyte: "CRP",
        value: null,
        valueText: "<5 mg/L",
        unit: "mg/L",
      }),
    ]);
    expect(result.statuses).toEqual([{ status: "duplicate" }]);
  });

  it("matches a number against a stored censored text result", async () => {
    const ige = await marker("IgE", "kU/L");
    await stored(ige.id, "IgE", { valueText: "<0.1" }, "kU/L", {
      takenAt: DRAW,
    });
    const result = await write([
      reading(1, { analyte: "IgE", value: 0.1, unit: "kU/L" }),
      reading(2, { analyte: "IgE", value: 0.2, unit: "kU/L" }),
    ]);
    expect(result.statuses).toEqual([
      { status: "duplicate" },
      { status: "inserted" },
    ]);
  });
});

describe("a censored result that is another reading", () => {
  it("keeps serial draws on one day apart", async () => {
    // A high-sensitivity troponin at 0 h below the limit, at 3 h at it.
    const troponin = await marker("Troponin T hs", "ng/L");
    await stored(troponin.id, "Troponin T hs", { value: 5 }, "ng/L", {
      takenAt: new Date("2026-06-10T11:30:00.000Z"),
    });
    const result = await write([
      reading(1, {
        analyte: "Troponin T hs",
        value: null,
        valueText: "<5",
        unit: "ng/L",
        takenAt: new Date("2026-06-10T08:30:00.000Z"),
      }),
    ]);
    expect(result.statuses).toEqual([{ status: "inserted" }]);
  });

  it("does not meet a number stored in another unit", async () => {
    const crp = await marker("CRP", "mg/L");
    await stored(crp.id, "CRP", { value: 5 }, "mg/L", { takenAt: DRAW });
    const result = await write([
      reading(1, {
        analyte: "CRP",
        value: null,
        valueText: "<5 mg/dL",
        unit: "mg/dL",
      }),
    ]);
    expect(result.statuses).toEqual([{ status: "inserted" }]);
  });
});

describe("a new reading", () => {
  it("gives a marker without a unit the unit it states while it holds no number", async () => {
    const ratio = await marker("Albumin/creatinine", "");
    await stored(ratio.id, "Albumin/creatinine", { valueText: "SEE NOTE" }, "");
    const result = await write([
      reading(1, { analyte: "Albumin/creatinine", value: 12, unit: "mg/g" }),
    ]);
    expect(result.statuses).toEqual([{ status: "inserted" }]);
    expect(
      (await prisma.biomarker.findUniqueOrThrow({ where: { id: ratio.id } }))
        .unit,
    ).toBe("mg/g");
  });

  it("refuses a number under a marker without a unit that holds numbers", async () => {
    const hb = await marker("Haemoglobin", "");
    const old = await stored(hb.id, "Haemoglobin", { value: 14 }, "");
    const result = await write([
      reading(1, { analyte: "Haemoglobin", value: 140, unit: "g/L" }),
    ]);
    expect(result.statuses).toEqual([
      { status: "failed", reason: "marker_unit_unset" },
    ]);
    expect(
      (await prisma.biomarker.findUniqueOrThrow({ where: { id: hb.id } })).unit,
    ).toBe("");
    const kept = await prisma.labResult.findUniqueOrThrow({
      where: { id: old.id },
    });
    expect(kept.unit).toBe("");
    expect(kept.value).toBe(14);
    expect(
      await prisma.labResult.count({ where: { biomarkerId: hb.id } }),
    ).toBe(1);
  });

  it("writes under a marker that spells its count unit another way", async () => {
    const platelets = await marker("Platelets", "x10E3/uL");
    const wbc = await marker("Leukocytes", "10*9/L");
    const ddimer = await marker("D-Dimer", "ng/mL (FEU)");
    const result = await write([
      reading(1, { analyte: "Platelets", value: 260, unit: "10^9/L" }),
      reading(2, { analyte: "Leukocytes", value: 6.1, unit: "10^9/L" }),
      reading(3, { analyte: "D-Dimer", value: 410, unit: "ng/ml (FEU)" }),
    ]);
    expect(result.statuses).toEqual([
      { status: "inserted" },
      { status: "inserted" },
      { status: "inserted" },
    ]);
    const rows = await prisma.labResult.findMany({
      where: { userId: USER },
      select: { biomarkerId: true, value: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { biomarkerId: platelets.id, value: 260 },
        { biomarkerId: wbc.id, value: 6.1 },
        { biomarkerId: ddimer.id, value: 410 },
      ]),
    );
  });
});

describe("migration 0513 on stored censored copies", () => {
  const MIGRATION = readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/0513_apple_health_export_duplicates/migration.sql",
    ),
    "utf8",
  );
  async function applyMigration() {
    const blocks = MIGRATION.split(/(?<=\$migration\$;)/)
      .map((block) => block.replace(/^(\s*--[^\n]*\n)*/g, "").trim())
      .filter((block) => block.startsWith("DO"));
    for (const block of blocks) await prisma.$executeRawUnsafe(block);
  }

  it("soft-deletes the newer Apple Health copy and nothing else", async () => {
    const crp = await marker("CRP", "mg/L");
    const egfr = await marker("eGFR", "mL/min");
    const number = await stored(crp.id, "CRP", { value: 5 }, "mg/L", {
      createdAt: new Date("2026-06-11T00:00:00Z"),
      takenAt: DRAW,
    });
    // Serial draws on one day: 0 h below the limit, 3 h at it. Both stay.
    const troponin = await marker("Troponin T hs", "ng/L");
    const firstDraw = await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: troponin.id,
        analyte: "Troponin T hs",
        valueText: "<5",
        unit: "ng/L",
        takenAt: new Date("2026-06-10T08:30:00.000Z"),
        source: "APPLE_HEALTH",
        externalId: "fhir:clinic:tnt-0h",
        createdAt: new Date("2026-11-18T00:00:00Z"),
      },
    });
    const secondDraw = await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: troponin.id,
        analyte: "Troponin T hs",
        value: 5,
        unit: "ng/L",
        takenAt: new Date("2026-06-10T11:30:00.000Z"),
        source: "APPLE_HEALTH",
        externalId: "fhir:clinic:tnt-3h",
        createdAt: new Date("2026-11-18T00:00:01Z"),
      },
    });
    // The same instant, but the bound is printed in another unit: stays.
    const otherUnit = await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: crp.id,
        analyte: "CRP",
        valueText: "<5 mg/dL",
        unit: "mg/L",
        takenAt: DRAW,
        source: "APPLE_HEALTH",
        externalId: "fhir:clinic:crp-dl",
        createdAt: new Date("2026-11-18T00:00:00Z"),
      },
    });
    const copy = await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: crp.id,
        analyte: "CRP",
        valueText: "<5 mg/L",
        unit: "mg/L",
        takenAt: DRAW,
        source: "APPLE_HEALTH",
        externalId: "fhir:clinic:crp",
        createdAt: new Date("2026-11-18T00:00:00Z"),
      },
    });
    // Another day, another number, a hand-typed text: all stay.
    const otherDay = await prisma.labResult.create({
      data: {
        userId: USER,
        biomarkerId: crp.id,
        analyte: "CRP",
        valueText: "<5 mg/L",
        unit: "mg/L",
        takenAt: new Date("2026-06-12T06:30:00Z"),
        source: "APPLE_HEALTH",
        externalId: "fhir:clinic:crp-2",
        createdAt: new Date("2026-11-18T00:00:00Z"),
      },
    });
    const otherValue = await stored(egfr.id, "eGFR", { value: 88 }, "mL/min");
    const typed = await stored(
      egfr.id,
      "eGFR",
      { valueText: ">90" },
      "mL/min",
      {
        createdAt: new Date("2026-11-18T00:00:00Z"),
      },
    );

    await applyMigration();
    const deletedAt = async (id: string) =>
      (await prisma.labResult.findUniqueOrThrow({ where: { id } })).deletedAt;
    expect(await deletedAt(copy.id)).not.toBeNull();
    expect(await deletedAt(number.id)).toBeNull();
    expect(await deletedAt(otherDay.id)).toBeNull();
    expect(await deletedAt(otherValue.id)).toBeNull();
    expect(await deletedAt(typed.id)).toBeNull();
    expect(await deletedAt(firstDraw.id)).toBeNull();
    expect(await deletedAt(secondDraw.id)).toBeNull();
    expect(await deletedAt(otherUnit.id)).toBeNull();

    // A second application changes nothing.
    const before = await prisma.labResult.findMany({ orderBy: { id: "asc" } });
    await applyMigration();
    expect(await prisma.labResult.findMany({ orderBy: { id: "asc" } })).toEqual(
      before,
    );

    // And the next export finds the copy by its identity.
    const again = await write([
      reading(1, {
        externalId: "fhir:clinic:crp",
        analyte: "CRP",
        value: null,
        valueText: "<5 mg/L",
        unit: "mg/L",
      }),
    ]);
    expect(again.statuses).toEqual([{ status: "duplicate" }]);
  });
});
