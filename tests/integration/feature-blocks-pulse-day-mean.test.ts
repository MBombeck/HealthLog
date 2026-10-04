/**
 * The full-history pulse mean the insight features carry (`allTimeAvg`) is the
 * mean of the day values, each day the mean of its hours' means, like every
 * other pulse mean (`day-mean.ts`). Count-weighted, a workout day's dense hour
 * outweighed every resting hour of every other day.
 *
 * Two days: a workout hour of twelve readings at 150 and three resting hours
 * at 60 (day value 82.5), and a day with one reading at 60: 71.25. The same
 * readings as systolic pressure keep the plain mean (127.5) as the control.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";

const prisma = getPrismaClient();
const USER = "feature-blocks-pulse-day";
const DAY = 86_400_000;
const now = new Date();
const midnight = (daysAgo: number) =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
  daysAgo * DAY;

function readings(
  type: "PULSE" | "BLOOD_PRESSURE_SYS",
  unit: string,
): Prisma.MeasurementCreateManyInput[] {
  const workout = midnight(40);
  const at: Array<[number, number]> = [];
  for (let i = 0; i < 12; i += 1) {
    at.push([workout + 10 * 3_600_000 + i * 300_000, 150]);
  }
  for (const h of [12, 14, 16]) at.push([workout + h * 3_600_000, 60]);
  at.push([midnight(39) + 8 * 3_600_000, 60]);
  return at.map(([ms, value], i) => ({
    id: `${USER}-${type}-${i}`,
    userId: USER,
    type,
    unit,
    source: "APPLE_HEALTH",
    value,
    measuredAt: new Date(ms),
  }));
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
  await prisma.measurement.createMany({
    data: [
      ...readings("PULSE", "bpm"),
      ...readings("BLOOD_PRESSURE_SYS", "mmHg"),
    ],
  });
}, 120_000);

describe("readAllTimeExtremes", () => {
  it("gives pulse the mean of its days, each the mean of its hours", async () => {
    const out = await readAllTimeExtremes(USER, [
      "PULSE",
      "BLOOD_PRESSURE_SYS",
    ]);
    const pulse = out.get("PULSE");
    expect(pulse?.mean).toBeCloseTo(71.25, 9);
    // The extremes stay over every reading.
    expect(pulse?.min).toBe(60);
    expect(pulse?.max).toBe(150);
  });

  it("keeps the plain mean of the readings for every other type", async () => {
    const out = await readAllTimeExtremes(USER, ["BLOOD_PRESSURE_SYS"]);
    expect(out.get("BLOOD_PRESSURE_SYS")?.mean).toBe(127.5);
  });
});
