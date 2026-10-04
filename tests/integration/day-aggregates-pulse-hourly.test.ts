/**
 * The per-day fold the background readers share (`readDayAggregates`) carries
 * the hourly-mean day for pulse, cut on the requested zone's own hours and
 * days; the vitals baseline and the tiered context read their live pulse days
 * from it.
 *
 * Asia/Kolkata (UTC+05:30). Day one: six readings at 150 from 04:45Z to
 * 04:55Z and two at 150 at 05:05Z and 05:10Z (all local 10:15 to 10:40, one
 * local hour, two UTC hours), then one reading at 60 in each of local hours
 * 12, 14 and 16. Hours' means 150, 60, 60, 60, day value 82.5; the readings
 * average (8 x 150 + 180) / 11 = 125.45. Day two: one reading at 60.
 *
 * A second workout day ten days earlier (12:45Z to 13:10Z, local 18:15 to
 * 18:40, then one reading at 60 at 14:00Z, 15:00Z and 16:00Z) sits in the
 * tiered context's day band, which a zone this far from UTC reads live.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { readDayMeanSeries } from "@/lib/insights/derived/baseline";
import { buildTieredSeries } from "@/lib/rollups/tiered-context";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const USER = "day-aggregates-pulse-hourly";
const TZ = "Asia/Kolkata";
const now = new Date();
const D = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - 10,
);
const at = (h: number, m: number) => new Date(D + h * 3_600_000 + m * 60_000);
const dayKey = (ms: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: TZ },
  });
  invalidateUserTimezone(USER);
  const readings: Array<[Date, number]> = [
    ...[45, 47, 49, 51, 53, 55].map((m): [Date, number] => [at(4, m), 150]),
    [at(5, 5), 150],
    [at(5, 10), 150],
    [at(6, 30), 60],
    [at(8, 30), 60],
    [at(10, 30), 60],
    [at(24 + 4, 0), 60],
    ...[45, 47, 49, 51, 53, 55, 65, 70].map((m): [Date, number] => [
      at(-10 * 24 + 12, m),
      150,
    ]),
    [at(-10 * 24 + 14, 0), 60],
    [at(-10 * 24 + 15, 0), 60],
    [at(-10 * 24 + 16, 0), 60],
  ];
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (const type of ["PULSE", "HEART_RATE_VARIABILITY"] as const) {
    readings.forEach(([measuredAt, value], i) =>
      rows.push({
        id: `${type}-${i}`,
        userId: USER,
        type,
        unit: type === "PULSE" ? "bpm" : "ms",
        source: "APPLE_HEALTH",
        value,
        measuredAt,
      }),
    );
  }
  await prisma.measurement.createMany({ data: rows });
}, 120_000);

describe("readDayAggregates", () => {
  it("carries the hourly-mean day for pulse, on the zone's own hours", async () => {
    const days = await readDayAggregates({
      userId: USER,
      type: "PULSE",
      since: new Date(D - 86_400_000),
      timeZone: TZ,
    });
    expect(days.map((d) => d.day)).toEqual([
      dayKey(D + 5 * 3_600_000),
      dayKey(D + 28 * 3_600_000),
    ]);
    expect(days[0]).toMatchObject({ n: 11, min: 60, max: 150 });
    expect(days[0].sum).toBe(8 * 150 + 3 * 60);
    expect(days[0].dayMean).toBeCloseTo(82.5, 9);
    expect(days[1].dayMean).toBeCloseTo(60, 9);
  });

  it("splits the hours per segment", async () => {
    const days = await readDayAggregates({
      userId: USER,
      type: "PULSE",
      since: new Date(D - 86_400_000),
      timeZone: TZ,
      // Readings before 08:00Z (the workout and local hour 12) fall into
      // segment 1, the rest of the day into segment 0.
      segmentStarts: [at(8, 0)],
    });
    const first = days.filter((d) => d.day === dayKey(D + 5 * 3_600_000));
    expect(first.map((d) => [d.segment, d.dayMean])).toEqual([
      [1, expect.closeTo(105, 9)],
      [0, expect.closeTo(60, 9)],
    ]);
  });

  it("leaves every other type without a day mean", async () => {
    const days = await readDayAggregates({
      userId: USER,
      type: "HEART_RATE_VARIABILITY",
      since: new Date(D - 86_400_000),
      timeZone: TZ,
    });
    expect(days[0].dayMean ?? null).toBeNull();
  });
});

describe("live pulse days of the readers built on it", () => {
  it("the vitals baseline", async () => {
    const { points, source } = await readDayMeanSeries(
      USER,
      "PULSE",
      30,
      now,
      new Map(),
      TZ,
    );
    expect(source).toBe("live");
    expect(points.map((p) => p.mean)).toEqual([
      expect.closeTo(82.5, 9),
      expect.closeTo(82.5, 9),
      expect.closeTo(60, 9),
    ]);
    const hrv = await readDayMeanSeries(
      USER,
      "HEART_RATE_VARIABILITY",
      30,
      now,
      new Map(),
      TZ,
    );
    expect(hrv.points[0].mean).toBeCloseTo((8 * 150 + 3 * 60) / 11, 9);
  });

  it("the tiered context's recent days and its live day band", async () => {
    const series = await buildTieredSeries(USER, "PULSE", {
      now: now.getTime(),
      tz: TZ,
      skipEnsureFresh: true,
    });
    expect(series.recentDaily.map((p) => [p.value, p.count])).toEqual([
      [82.5, 11],
      [60, 1],
    ]);
    const workout = series.dayBand.find((b) => b.count === 11);
    expect(workout?.mean).toBeCloseTo(82.5, 2);
    const hrv = await buildTieredSeries(USER, "HEART_RATE_VARIABILITY", {
      now: now.getTime(),
      tz: TZ,
      skipEnsureFresh: true,
    });
    expect(hrv.recentDaily[0].value).toBeCloseTo((8 * 150 + 180) / 11, 2);
    expect(hrv.dayBand.find((b) => b.count === 11)?.mean).toBeCloseTo(
      (8 * 150 + 180) / 11,
      2,
    );
  });
});
