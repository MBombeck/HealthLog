/**
 * The "All" range reaches a record's whole history.
 *
 * Rollups are kept for the last five years. A range longer than a year reads
 * its series from the week or month rollups, and on a record that goes back
 * further it used to start where the rollups start: a weight history from
 * 2018 charted from five years ago. The older readings are folded live at
 * the same grain and lead the series, without a month counted twice where
 * the two meet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDailySeries } from "@/lib/measurements/daily-series-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

import { makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY = 86_400_000;

beforeAll(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await truncateAllTables(prisma);
});

describe("the All range over a history older than the rollups", () => {
  it("leads with the readings the rollups do not hold", async () => {
    const user = await makeUser({ timezone: "Europe/Berlin" });
    const now = Date.now();
    // A weekly weight from eight years ago until now.
    const weeks = Math.floor((8 * 365) / 7);
    await prisma.measurement.createMany({
      data: Array.from({ length: weeks }, (_, i) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: 80 + (i % 10) / 10,
        unit: "kg",
        measuredAt: new Date(now - (weeks - i) * 7 * DAY),
        source: "MANUAL" as const,
      })),
    });
    await recomputeUserRollups(user.id, { types: ["WEIGHT"] });
    const oldestRollup = await prisma.measurementRollup.aggregate({
      where: { userId: user.id, type: "WEIGHT", granularity: "DAY" },
      _min: { bucketStart: true },
    });
    // The setup holds what production holds: no rollup older than five years.
    expect(oldestRollup._min.bucketStart!.getTime()).toBeGreaterThan(
      now - 5 * 366 * DAY,
    );

    const rows = await readDailySeries({
      userId: user.id,
      type: "WEIGHT",
      from: new Date(now - 3650 * DAY),
      to: new Date(now),
      priorityJson: null,
    });

    const first = new Date(rows[0]!.measuredAt).getTime();
    expect(first).toBeLessThan(now - 7.5 * 365 * DAY);
    const last = new Date(rows[rows.length - 1]!.measuredAt).getTime();
    expect(last).toBeGreaterThan(now - 62 * DAY);

    // Monthly buckets, in order, each month once.
    const months = rows.map((row) =>
      new Date(row.measuredAt).toISOString().slice(0, 7),
    );
    expect(new Set(months).size).toBe(months.length);
    expect([...months].sort()).toEqual(months);
    // Eight years of weekly readings fill about 96 months.
    expect(months.length).toBeGreaterThanOrEqual(94);
  });

  it("reads the rollups alone when the history starts inside them", async () => {
    const user = await makeUser({ timezone: "Europe/Berlin" });
    const now = Date.now();
    await prisma.measurement.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        userId: user.id,
        type: "WEIGHT" as const,
        value: 80,
        unit: "kg",
        measuredAt: new Date(now - (150 - i) * 7 * DAY),
        source: "MANUAL" as const,
      })),
    });
    await recomputeUserRollups(user.id, { types: ["WEIGHT"] });
    const rows = await readDailySeries({
      userId: user.id,
      type: "WEIGHT",
      from: new Date(now - 3650 * DAY),
      to: new Date(now),
      priorityJson: null,
    });
    const months = rows.map((row) =>
      new Date(row.measuredAt).toISOString().slice(0, 7),
    );
    expect(new Set(months).size).toBe(months.length);
    expect(new Date(rows[0]!.measuredAt).getTime()).toBeGreaterThan(
      now - 151 * 7 * DAY - 31 * DAY,
    );
  });
});
