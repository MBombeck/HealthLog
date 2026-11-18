/**
 * The medication Effect view against a real Postgres, for an account that
 * reads glucose in mmol/L and weight in pounds (#1406). A GLP-1 resolves to
 * both targets; each must come back in the account's unit — series, before /
 * after means, the reference band and the unit symbol — while an mg/dL,
 * metric account keeps the stored figures.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { buildMedicationEfficacy } from "@/lib/medications/efficacy/build-efficacy";

import { getPrismaClient, truncateAllTables } from "./setup";

const DAY = 86_400_000;
const PIVOT = Date.parse("2026-03-01T00:00:00.000Z");
const NOW = new Date(PIVOT + 29 * DAY + 12 * 3_600_000);

let mmolUser = "";
let mgdlUser = "";
let mmolMed = "";
let mgdlMed = "";

async function seed(userId: string): Promise<string> {
  const prisma = getPrismaClient();
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (let t = -30; t < 30; t++) {
    const measuredAt = new Date(PIVOT + t * DAY + 8 * 3_600_000);
    rows.push(
      {
        userId,
        type: "BLOOD_GLUCOSE",
        value: t < 0 ? 180 : 144,
        unit: "mg/dL",
        source: "MANUAL",
        glucoseContext: "FASTING",
        measuredAt,
      },
      {
        userId,
        type: "WEIGHT",
        value: t < 0 ? 100 : 90,
        unit: "kg",
        source: "MANUAL",
        measuredAt,
      },
    );
  }
  await prisma.measurement.createMany({ data: rows });
  const med = await prisma.medication.create({
    data: {
      userId,
      name: "Semaglutide",
      dose: "1 mg",
      treatmentClass: "GENERIC",
      atcCode: "A10BJ06",
      trackIntake: false,
      startsOn: new Date(PIVOT),
    },
  });
  return med.id;
}

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const mmol = await prisma.user.create({
    data: {
      username: "efficacy-mmol",
      email: "efficacy-mmol@example.test",
      timezone: "UTC",
      glucoseUnit: "mmol/L",
      unitPreference: "imperial",
    },
  });
  mmolUser = mmol.id;
  const mgdl = await prisma.user.create({
    data: {
      username: "efficacy-mgdl",
      email: "efficacy-mgdl@example.test",
      timezone: "UTC",
    },
  });
  mgdlUser = mgdl.id;
  mmolMed = await seed(mmolUser);
  mgdlMed = await seed(mgdlUser);
});

describe("medication efficacy in the account's unit", () => {
  it("reads glucose in mmol/L and weight in pounds", async () => {
    const dto = await buildMedicationEfficacy(mmolUser, mmolMed, "UTC", NOW);
    expect(dto?.eligible).toBe(true);
    const glucose = dto!.targets.find((t) => t.key === "BLOOD_GLUCOSE")!;
    expect(glucose.unit).toBe("mmol/L");
    expect(glucose.referenceBand).toEqual({ low: 3.9, high: 7.8 });
    expect(glucose.series[0].value).toBe(10);
    expect(glucose.series.at(-1)!.value).toBe(8);
    expect(glucose.beforeAfter.before?.mean).toBe(10);
    expect(glucose.beforeAfter.after?.mean).toBe(8);
    expect(glucose.beforeAfter.delta?.mean).toBe(-2);
    expect(glucose.beforeAfter.delta?.pct).toBe(-20);
    if (glucose.segmented?.present) {
      expect(glucose.segmented.levelChange!.estimate).toBeCloseTo(-2, 1);
    }

    const weight = dto!.targets.find((t) => t.key === "WEIGHT")!;
    expect(weight.unit).toBe("lb");
    expect(weight.series[0].value).toBe(220.5);
    expect(weight.beforeAfter.after?.mean).toBe(198.4);
  });

  it("keeps the stored figures for an mg/dL, metric account", async () => {
    const dto = await buildMedicationEfficacy(mgdlUser, mgdlMed, "UTC", NOW);
    const glucose = dto!.targets.find((t) => t.key === "BLOOD_GLUCOSE")!;
    expect(glucose.unit).toBe("mg/dL");
    expect(glucose.referenceBand).toEqual({ low: 70, high: 140 });
    expect(glucose.series[0].value).toBe(180);
    expect(glucose.beforeAfter.delta?.mean).toBe(-36);
    const weight = dto!.targets.find((t) => t.key === "WEIGHT")!;
    expect(weight.unit).toBe("kg");
    expect(weight.series[0].value).toBe(100);
  });
});
