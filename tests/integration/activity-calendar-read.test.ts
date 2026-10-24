/**
 * The activity calendar's reader against a real Postgres (D1036).
 *
 *   - steps resolve to the source the person's ladder picks per day, so a day
 *     two devices counted shows one device's total, never the sum;
 *   - the day is the person's local day: a reading at 23:30 Berlin time lands
 *     on that day, not on the UTC day after;
 *   - a workout two devices recorded counts once, its minutes once;
 *   - the window is exact: nothing before `fromKey` or after `toKey`.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readActivityDays } from "@/lib/activity/calendar-read";
import { invalidateUserTimezone } from "@/lib/tz/resolver";
import { userDayKey } from "@/lib/tz/format";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const TZ = "Europe/Berlin";
const USER = "activity-reader";
const DAY = 86_400_000;
const NOW = new Date();

function daysAgo(n: number, hourUtc = 10): Date {
  const d = new Date(NOW.getTime() - n * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: USER,
      timezone: TZ,
      sourcePriorityJson: {
        metricPriority: { steps: ["FITBIT", "APPLE_HEALTH"] },
      },
    },
  });
  invalidateUserTimezone(USER);

  await prisma.measurement.createMany({
    data: [
      // Day 3: both devices; the ladder picks Fitbit's 8 000.
      {
        userId: USER,
        type: "ACTIVITY_STEPS",
        value: 9500,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(3),
      },
      {
        userId: USER,
        type: "ACTIVITY_STEPS",
        value: 8000,
        unit: "steps",
        source: "FITBIT",
        measuredAt: daysAgo(3),
      },
      // Day 2: Apple only, two slices that add up.
      {
        userId: USER,
        type: "ACTIVITY_STEPS",
        value: 3000,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(2, 8),
      },
      {
        userId: USER,
        type: "ACTIVITY_STEPS",
        value: 4000,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(2, 15),
      },
      // 21:30 UTC is 23:30 in Berlin (summer) or 22:30 (winter): still day 5 locally.
      {
        userId: USER,
        type: "ACTIVITY_STEPS",
        value: 1200,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(5, 21),
      },
      {
        userId: USER,
        type: "EXERCISE_MINUTES",
        value: 25,
        unit: "min",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(3, 9),
      },
      {
        userId: USER,
        type: "EXERCISE_MINUTES",
        value: 15,
        unit: "min",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(3, 17),
      },
      // Outside the window asked for below.
      {
        userId: USER,
        type: "ACTIVITY_STEPS",
        value: 777,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: daysAgo(40),
      },
    ],
  });

  const start = daysAgo(3, 7);
  await prisma.workout.createMany({
    data: [
      {
        userId: USER,
        sportType: "running",
        startedAt: start,
        endedAt: new Date(start.getTime() + 40 * 60_000),
        durationSec: 2400,
        source: "APPLE_HEALTH",
        externalId: "hk-1",
      },
      {
        userId: USER,
        sportType: "running",
        startedAt: new Date(start.getTime() + 30_000),
        endedAt: new Date(start.getTime() + 40 * 60_000),
        durationSec: 2370,
        source: "FITBIT",
        externalId: "fb-1",
      },
    ],
  });
});

describe("readActivityDays", () => {
  it("follows the ladder, the local day and the workout collapse", async () => {
    const fromKey = userDayKey(daysAgo(10), TZ);
    const toKey = userDayKey(NOW, TZ);
    const { days } = await readActivityDays({
      userId: USER,
      tz: TZ,
      fromKey,
      toKey,
      includeWorkouts: true,
    });
    const by = new Map(days.map((d) => [d.date, d]));

    const d3 = by.get(userDayKey(daysAgo(3), TZ));
    expect(d3?.steps).toBe(8000);
    expect(d3?.exerciseMinutes).toBe(40);
    expect(d3?.workoutCount).toBe(1);
    expect(d3?.workoutsBySport).toEqual({ running: 1 });
    expect(d3?.workoutMinutes).toBe(40);

    expect(by.get(userDayKey(daysAgo(2), TZ))?.steps).toBe(7000);
    expect(by.get(userDayKey(daysAgo(5, 21), TZ))?.steps).toBe(1200);
    expect(days.every((d) => d.date >= fromKey && d.date <= toKey)).toBe(true);
    expect(days.some((d) => d.steps === 777)).toBe(false);
  });
});
