/**
 * The pulse status card's graded series reads per-day aggregates folded in
 * Postgres (`readDayAggregates`). For pulse those rows carry the day weights
 * of `day-mean.ts`, so a recent day is the mean of its hours' means and a
 * week the mean of its days, against a real database.
 *
 * Each pair of days: a workout hour of twelve readings at 150 and three
 * resting hours at 60 (day value 82.5), then a day with one reading at 60.
 * A bucket over both reads 71.25; the plain mean of the readings is 127.5.
 * Systolic pressure with the same readings keeps the plain mean.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { buildGradedSeriesWithRollups } from "@/lib/insights/graded-series";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";

const prisma = getPrismaClient();
const USER = "graded-pulse-day";
const DAY = 86_400_000;
const now = new Date();
const today = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate(),
);
/** A Monday about six weeks back: its Tuesday and Wednesday share a week. */
const dow = (new Date(today).getUTCDay() + 6) % 7;
const OLD_MONDAY = today - dow * DAY - 6 * 7 * DAY;
const RECENT = today - 4 * DAY;

function pair(
  type: "PULSE" | "BLOOD_PRESSURE_SYS",
  start: number,
  tag: string,
): Prisma.MeasurementCreateManyInput[] {
  const at: Array<[number, number]> = [];
  for (let i = 0; i < 12; i += 1) {
    at.push([start + 10 * 3_600_000 + i * 300_000, 150]);
  }
  for (const h of [12, 14, 16]) at.push([start + h * 3_600_000, 60]);
  at.push([start + DAY + 8 * 3_600_000, 60]);
  return at.map(([ms, value], i) => ({
    id: `${USER}-${type}-${tag}-${i}`,
    userId: USER,
    type,
    unit: type === "PULSE" ? "bpm" : "mmHg",
    source: "APPLE_HEALTH",
    value,
    measuredAt: new Date(ms),
  }));
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({ data: { id: USER, username: USER } });
  const data: Prisma.MeasurementCreateManyInput[] = [];
  for (const type of ["PULSE", "BLOOD_PRESSURE_SYS"] as const) {
    data.push(...pair(type, RECENT, "recent"));
    data.push(...pair(type, OLD_MONDAY + DAY, "old"));
  }
  await prisma.measurement.createMany({ data });
}, 120_000);

describe("readDayAggregates for pulse", () => {
  it("carries day weights whose ratio is the day value", async () => {
    const rows = await readDayAggregates({
      userId: USER,
      type: "PULSE",
      since: new Date(RECENT),
      timeZone: "UTC",
    });
    const workout = rows.find(
      (r) => r.day === new Date(RECENT).toISOString().slice(0, 10),
    )!;
    expect(workout.n).toBe(15);
    expect(workout.min).toBe(60);
    expect(workout.max).toBe(150);
    expect(workout.weightSum).toBeCloseTo(1, 9);
    expect(workout.weightedSum! / workout.weightSum!).toBeCloseTo(82.5, 9);
  });

  it("leaves every other type without them", async () => {
    const rows = await readDayAggregates({
      userId: USER,
      type: "BLOOD_PRESSURE_SYS",
      since: new Date(RECENT),
      timeZone: "UTC",
    });
    expect(rows.every((r) => r.weightedSum === undefined)).toBe(true);
  });
});

describe("the pulse graded series", () => {
  it("gives a recent day its hours' mean and a week its days' mean", async () => {
    const g = await buildGradedSeriesWithRollups(USER, "PULSE", now, "UTC");
    const workout = g.recent.find(
      (d) => d.date === new Date(RECENT).toISOString().slice(0, 10),
    )!;
    expect(workout.mean).toBe(82.5);
    expect(workout.n).toBe(15);
    expect(g.weekly).toHaveLength(1);
    expect(g.weekly[0].mean).toBe(71.25);
    expect(g.weekly[0].n).toBe(16);
  });

  it("keeps the plain mean for systolic pressure", async () => {
    const g = await buildGradedSeriesWithRollups(
      USER,
      "BLOOD_PRESSURE_SYS",
      now,
      "UTC",
    );
    expect(g.weekly[0].mean).toBe(127.5);
  });
});
