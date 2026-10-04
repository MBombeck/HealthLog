/**
 * The comparison snapshot's window average and the Coach's availability mean
 * read pulse as the mean of its days, each the mean of its hours' means, on a
 * real Postgres.
 *
 * Two days, three days back and two days back (inside the 30-day window): a
 * workout day with one hour of 12 readings at 150 and three resting hours of
 * one reading at 60 (day value 82.5), and a resting day of two hours at 70.
 * Mean of the days: 76.25. Mean of the readings: (12 x 150 + 3 x 60 + 2 x 70)
 * / 17 = 124.7.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { probeCoachAvailability } from "@/lib/ai/coach/tools/availability";
import { hourlyMeanWindowAverage } from "@/lib/insights/comprehensive-generate";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

const prisma = getPrismaClient();
const USER = "pulse-comparison-availability";
const DAY = 86_400_000;
const now = new Date();
const D1 = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - 3,
);
const D2 = D1 + DAY;
const DAY_MEAN = (82.5 + 70) / 2;
const READING_MEAN = (12 * 150 + 3 * 60 + 2 * 70) / 17;

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  invalidateUserTimezone(USER);
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const add = (at: number, value: number) =>
    rows.push({
      id: `${USER}-${rows.length}`,
      userId: USER,
      type: "PULSE",
      unit: "bpm",
      source: "APPLE_HEALTH",
      value,
      measuredAt: new Date(at),
    });
  for (let i = 0; i < 12; i += 1) add(D1 + 10 * 3_600_000 + i * 300_000, 150);
  for (const h of [12, 14, 16]) add(D1 + h * 3_600_000, 60);
  for (const h of [8, 9]) add(D2 + h * 3_600_000, 70);
  await prisma.measurement.createMany({ data: rows });
}, 120_000);

describe("pulse window means on a real database", () => {
  it("the fixture separates the two statistics", () => {
    expect(READING_MEAN).toBeCloseTo(124.71, 2);
    expect(DAY_MEAN).toBe(76.25);
  });

  it("the comparison snapshot's window average is the mean of the days", async () => {
    const avg = await hourlyMeanWindowAverage(USER, "PULSE", {
      gt: new Date(Date.now() - 30 * DAY),
    });
    expect(avg).toBeCloseTo(DAY_MEAN, 9);
    const empty = await hourlyMeanWindowAverage(USER, "PULSE", {
      gt: new Date(Date.now() - 60 * DAY),
      lte: new Date(Date.now() - 30 * DAY),
    });
    expect(empty).toBeNull();
  });

  it("the Coach availability mean is the mean of the days", async () => {
    const probed = await probeCoachAvailability(
      USER,
      new Map([["pulse", { kind: "measurement", types: ["PULSE"] }]]),
      { now },
    );
    const series = probed.get("pulse")?.series;
    expect(series).toEqual([
      expect.objectContaining({
        series: "PULSE",
        count: 17,
        mean: Math.round(DAY_MEAN * 10) / 10,
        min: 60,
        max: 150,
      }),
    ]);
  });
});
