/**
 * A day of pulse is the mean of its hours' means, and a window of days weighs
 * each day once.
 *
 * A watch samples about every 5 to 10 minutes at rest and about every 5 seconds
 * in a workout, so a plain mean over a day's readings counts the workout hour
 * hundreds of times and the other twenty-three hours a few dozen times each.
 * The worked example here is the one from the issue: a workout hour of 700
 * readings at 150 bpm and 23 resting hours of 10 readings at 60 bpm.
 *
 *   mean of the readings    (700 x 150 + 230 x 60) / 930 = 127.7
 *   mean of the hours' means (150 + 23 x 60) / 24         =  63.75
 *
 * Asserted against a real Postgres, in every place a daily pulse value or a
 * window of days is made: the live per-day read the chart serves, the
 * rollup's DAY bucket and the weeks folded from it, and the series route's
 * day bucket. HRV is seeded with the very same readings as a control: a type
 * without an activity-dependent sampling rate keeps the plain mean.
 */
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { readLiveBuckets } from "@/lib/measurements/daily-series-read";
import { readCanonicalRollupBuckets } from "@/lib/rollups/measurement-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { invalidateUserTimezone } from "@/lib/tz/resolver";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const USER = "pulse-hourly-mean";
const DAY = 86_400_000;

/** Monday of the ISO week two weeks back, 00:00 UTC. */
const now = new Date();
const dow = (now.getUTCDay() + 6) % 7;
const MONDAY = Date.UTC(
  now.getUTCFullYear(),
  now.getUTCMonth(),
  now.getUTCDate() - dow - 14,
);
/** Tuesday: the workout day. Wednesday: an ordinary day. Same ISO week. */
const WORKOUT_DAY = MONDAY + DAY;
const REST_DAY = MONDAY + 2 * DAY;

const WORKOUT_HOUR = 10;
const WORKOUT_READINGS = 700;
const RESTING_READINGS_PER_HOUR = 10;

function dayRows(
  type: "PULSE" | "HEART_RATE_VARIABILITY",
  unit: string,
  dayStart: number,
  workout: boolean,
): Prisma.MeasurementCreateManyInput[] {
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  for (let h = 0; h < 24; h += 1) {
    const isWorkoutHour = workout && h === WORKOUT_HOUR;
    const n = isWorkoutHour ? WORKOUT_READINGS : RESTING_READINGS_PER_HOUR;
    for (let i = 0; i < n; i += 1) {
      // Inside the hour, at least 1 s apart; the workout hour is dense.
      const offsetMs = isWorkoutHour ? i * 5_000 : (5 + i * 4) * 60_000;
      rows.push({
        id: `${type}-${dayStart}-${h}-${i}`,
        userId: USER,
        type,
        unit,
        source: "APPLE_HEALTH",
        value: isWorkoutHour ? 150 : 60,
        measuredAt: new Date(dayStart + h * 3_600_000 + offsetMs),
      });
    }
  }
  return rows;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  invalidateUserTimezone(USER);
  for (const [type, unit] of [
    ["PULSE", "bpm"],
    ["HEART_RATE_VARIABILITY", "ms"],
  ] as const) {
    await prisma.measurement.createMany({
      data: [
        ...dayRows(type, unit, WORKOUT_DAY, true),
        ...dayRows(type, unit, REST_DAY, false),
      ],
    });
  }
  await recomputeUserRollups(USER, {
    types: ["PULSE", "HEART_RATE_VARIABILITY"],
    from: new Date(MONDAY),
    to: new Date(MONDAY + 7 * DAY),
  });
}, 120_000);

const SAMPLE_MEAN_WORKOUT_DAY =
  (WORKOUT_READINGS * 150 + 23 * RESTING_READINGS_PER_HOUR * 60) /
  (WORKOUT_READINGS + 23 * RESTING_READINGS_PER_HOUR);
const HOURLY_MEAN_WORKOUT_DAY = (150 + 23 * 60) / 24;

describe("the worked example", () => {
  it("really is two different numbers", () => {
    expect(SAMPLE_MEAN_WORKOUT_DAY).toBeCloseTo(127.74, 2);
    expect(HOURLY_MEAN_WORKOUT_DAY).toBeCloseTo(63.75, 5);
  });
});

describe("the live per-day read the chart serves", () => {
  const read = (
    type: "PULSE" | "HEART_RATE_VARIABILITY",
    grain: "daily" | "weekly",
  ) =>
    readLiveBuckets({
      userId: USER,
      type,
      from: new Date(MONDAY),
      to: new Date(MONDAY + 7 * DAY),
      cap: 400,
      priorityJson: null,
      grain,
      timeZone: "UTC",
    });

  it("gives a workout day the mean of its hours, not of its readings", async () => {
    const rows = await read("PULSE", "daily");
    const workout = rows.find(
      (r) => new Date(r.measuredAt).getTime() === WORKOUT_DAY,
    );
    expect(workout?.value).toBeCloseTo(HOURLY_MEAN_WORKOUT_DAY, 6);
    // The reading count and the band stay over every reading.
    expect(workout?.count).toBe(
      WORKOUT_READINGS + 23 * RESTING_READINGS_PER_HOUR,
    );
    expect(workout?.minValue).toBe(60);
    expect(workout?.maxValue).toBe(150);
    const rest = rows.find(
      (r) => new Date(r.measuredAt).getTime() === REST_DAY,
    );
    expect(rest?.value).toBeCloseTo(60, 6);
  });

  it("weighs each day once when it folds days into a week", async () => {
    const [week] = await read("PULSE", "weekly");
    // Mean of the two days' means, not of their readings (which would be ~114).
    expect(week.value).toBeCloseTo((HOURLY_MEAN_WORKOUT_DAY + 60) / 2, 6);
    expect(week.count).toBe(
      WORKOUT_READINGS +
        23 * RESTING_READINGS_PER_HOUR +
        24 * RESTING_READINGS_PER_HOUR,
    );
  });

  it("keeps the plain mean for a type with no activity-dependent sampling (HRV)", async () => {
    const rows = await read("HEART_RATE_VARIABILITY", "daily");
    const workout = rows.find(
      (r) => new Date(r.measuredAt).getTime() === WORKOUT_DAY,
    );
    expect(workout?.value).toBeCloseTo(SAMPLE_MEAN_WORKOUT_DAY, 6);
    const [week] = await read("HEART_RATE_VARIABILITY", "weekly");
    const total =
      WORKOUT_READINGS * 150 +
      23 * RESTING_READINGS_PER_HOUR * 60 +
      24 * RESTING_READINGS_PER_HOUR * 60;
    const readings = WORKOUT_READINGS + 47 * RESTING_READINGS_PER_HOUR;
    expect(week.value).toBeCloseTo(total / readings, 6);
  });
});

describe("the rollup tier", () => {
  const rollup = (
    type: "PULSE" | "HEART_RATE_VARIABILITY",
    granularity: "DAY" | "WEEK",
  ) =>
    readCanonicalRollupBuckets({
      userId: USER,
      type,
      granularity,
      from: new Date(MONDAY),
      to: new Date(MONDAY + 7 * DAY),
      toInclusive: true,
    });

  it("stores the mean of the hours' means as the DAY mean, and nothing else changes", async () => {
    const days = await rollup("PULSE", "DAY");
    const workout = days.find((d) => d.bucketStart.getTime() === WORKOUT_DAY)!;
    expect(workout.mean).toBeCloseTo(HOURLY_MEAN_WORKOUT_DAY, 6);
    expect(workout.count).toBe(
      WORKOUT_READINGS + 23 * RESTING_READINGS_PER_HOUR,
    );
    expect(workout.minValue).toBe(60);
    expect(workout.maxValue).toBe(150);
    // The sums the regression composes from stay over every reading.
    expect(workout.sumValue).toBe(
      WORKOUT_READINGS * 150 + 23 * RESTING_READINGS_PER_HOUR * 60,
    );
  });

  it("gives a week the mean of its days' means", async () => {
    const [week] = await rollup("PULSE", "WEEK");
    expect(week.days).toBe(2);
    expect(week.mean).toBeCloseTo((HOURLY_MEAN_WORKOUT_DAY + 60) / 2, 6);
    expect(week.dayMean).toBeCloseTo(week.mean, 9);
  });

  it("keeps the plain mean for HRV, DAY and WEEK alike", async () => {
    const days = await rollup("HEART_RATE_VARIABILITY", "DAY");
    const workout = days.find((d) => d.bucketStart.getTime() === WORKOUT_DAY)!;
    expect(workout.mean).toBeCloseTo(SAMPLE_MEAN_WORKOUT_DAY, 6);
    const [week] = await rollup("HEART_RATE_VARIABILITY", "WEEK");
    const total = WORKOUT_READINGS * 150 + 47 * RESTING_READINGS_PER_HOUR * 60;
    expect(week.mean).toBeCloseTo(
      total / (WORKOUT_READINGS + 47 * RESTING_READINGS_PER_HOUR),
      6,
    );
  });
});

describe("the series route's day bucket", () => {
  async function series(kind: string) {
    const s = await prisma.session.create({
      data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.clear();
    cookieJar.set("healthlog_session", s.id);
    const { GET } = await import("@/app/api/measurements/series/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/measurements/series?kind=${kind}&days=365`,
      ),
    );
    expect(res.status).toBe(200);
    return (
      (await res.json()) as {
        data: { points: Array<{ id: string; at: string; value: number }> };
      }
    ).data.points;
  }

  it("is the mean of the hours' means for pulse", async () => {
    const points = await series("pulse");
    expect(points.every((p) => p.id.startsWith("day:"))).toBe(true);
    const workout = points.find(
      (p) => new Date(p.at).getTime() === WORKOUT_DAY,
    );
    expect(workout?.value).toBeCloseTo(HOURLY_MEAN_WORKOUT_DAY, 2);
  });

  it("is the plain mean for HRV", async () => {
    const points = await series("heartRateVariability");
    const workout = points.find(
      (p) => new Date(p.at).getTime() === WORKOUT_DAY,
    );
    expect(workout?.value).toBeCloseTo(SAMPLE_MEAN_WORKOUT_DAY, 2);
  });
});
