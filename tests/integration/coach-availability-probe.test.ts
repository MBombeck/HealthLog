/**
 * The availability probe against real Postgres (#648).
 *
 * The unit suite mocks Prisma, so it proves the discriminant's logic and
 * nothing about the SQL underneath it. This file proves the query itself: a
 * grouped aggregate split by unit, and one aggregate per non-measurement table.
 * If a column name or an aggregate shape were wrong, the unit tests would stay
 * green and the Coach would fall back to `no_data_unconfirmed` in production —
 * which is honest, but it is not the fix.
 *
 * The fixture is the reported case: a fortnight of glucose readings from April
 * 2024, deliberately outside every window the Coach can search.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { probeCoachAvailability } from "@/lib/ai/coach/tools/availability";

const NOW = new Date("2026-07-26T09:00:00Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seedUser(username: string) {
  return getPrismaClient().user.create({
    data: {
      username,
      email: `${username}@example.test`,
      timezone: "UTC",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    },
  });
}

describe("probeCoachAvailability against Postgres", () => {
  it("reports the count, range and aggregate of a history no window reaches", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("historic-glucose");
    const rows = Array.from({ length: 120 }, (_, i) => ({
      userId: user.id,
      type: "BLOOD_GLUCOSE" as const,
      value: 80 + (i % 40),
      unit: "mg/dL",
      measuredAt: new Date(
        Date.UTC(2024, 3, 3 + Math.floor(i / 9), 6 + (i % 9), 0, 0),
      ),
    }));
    await prisma.measurement.createMany({ data: rows });

    const probed = await probeCoachAvailability(
      user.id,
      new Map([["glucose", { kind: "measurement", types: ["BLOOD_GLUCOSE"] }]]),
      { now: NOW },
    );

    const glucose = probed.get("glucose");
    expect(glucose?.count).toBe(120);
    expect(glucose?.firstDate).toBe("2024-04-03");
    expect(glucose?.lastDate).toBe("2024-04-16");
    // Older than a year, so no window would reach it — the honest sentence is
    // the whole answer and there is nothing to re-call with.
    expect(glucose?.reachableWithWindow).toBeNull();
    expect(glucose?.series).toEqual([
      {
        series: "BLOOD_GLUCOSE",
        unit: "mg/dL",
        count: 120,
        mean: expect.any(Number),
        min: 80,
        max: 119,
      },
    ]);
  });

  it("returns nothing at all for a domain the record is empty for", async () => {
    const user = await seedUser("empty-record");
    const probed = await probeCoachAvailability(
      user.id,
      new Map([["glucose", { kind: "measurement", types: ["BLOOD_GLUCOSE"] }]]),
      { now: NOW },
    );
    expect(probed.size).toBe(0);
  });

  it("never counts another account's rows", async () => {
    const prisma = getPrismaClient();
    const mine = await seedUser("mine");
    const theirs = await seedUser("theirs");
    await prisma.measurement.createMany({
      data: [
        {
          userId: theirs.id,
          type: "BLOOD_GLUCOSE",
          value: 95,
          unit: "mg/dL",
          measuredAt: new Date("2024-04-03T06:00:00Z"),
        },
      ],
    });
    const probed = await probeCoachAvailability(
      mine.id,
      new Map([["glucose", { kind: "measurement", types: ["BLOOD_GLUCOSE"] }]]),
      { now: NOW },
    );
    expect(probed.size).toBe(0);
  });

  it("ignores tombstoned rows", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("tombstoned");
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 81,
          unit: "kg",
          measuredAt: new Date("2024-04-03T06:00:00Z"),
          deletedAt: new Date("2024-05-01T00:00:00Z"),
        },
      ],
    });
    const probed = await probeCoachAvailability(
      user.id,
      new Map([["weight", { kind: "measurement", types: ["WEIGHT"] }]]),
      { now: NOW },
    );
    expect(probed.size).toBe(0);
  });

  it("withholds the aggregate when the history mixes units", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("mixed-units");
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 95,
          unit: "mg/dL",
          measuredAt: new Date("2024-04-03T06:00:00Z"),
        },
        {
          userId: user.id,
          type: "BLOOD_GLUCOSE",
          value: 5.3,
          unit: "mmol/L",
          measuredAt: new Date("2024-04-10T06:00:00Z"),
        },
      ],
    });
    const probed = await probeCoachAvailability(
      user.id,
      new Map([["glucose", { kind: "measurement", types: ["BLOOD_GLUCOSE"] }]]),
      { now: NOW },
    );
    const glucose = probed.get("glucose");
    expect(glucose?.count).toBe(2);
    expect(glucose?.firstDate).toBe("2024-04-03");
    expect(glucose?.lastDate).toBe("2024-04-10");
    // A mean across mg/dL and mmol/L is not a number that means anything.
    expect(glucose?.series).toBeUndefined();
  });

  it("reads the non-measurement domains from their own tables", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("other-tables");
    await prisma.workout.create({
      data: {
        userId: user.id,
        sportType: "RUNNING",
        startedAt: new Date("2023-05-02T17:00:00Z"),
        endedAt: new Date("2023-05-02T17:40:00Z"),
        durationSec: 2400,
        source: "MANUAL",
      },
    });
    await prisma.moodEntry.create({
      data: {
        userId: user.id,
        date: "2023-06-01",
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date("2023-06-01T20:00:00Z"),
      },
    });
    await prisma.labResult.create({
      data: {
        userId: user.id,
        analyte: "LDL",
        value: 3.1,
        unit: "mmol/L",
        takenAt: new Date("2022-09-14T08:00:00Z"),
      },
    });

    const probed = await probeCoachAvailability(
      user.id,
      new Map([
        ["workouts", { kind: "workout" }],
        ["mood", { kind: "mood" }],
        ["labs", { kind: "lab" }],
      ]),
      { now: NOW },
    );

    expect(probed.get("workouts")).toMatchObject({
      count: 1,
      firstDate: "2023-05-02",
      lastDate: "2023-05-02",
      reachableWithWindow: null,
    });
    expect(probed.get("mood")?.lastDate).toBe("2023-06-01");
    expect(probed.get("labs")?.lastDate).toBe("2022-09-14");
    // No value column to aggregate honestly on any of the three.
    expect(probed.get("workouts")?.series).toBeUndefined();
    expect(probed.get("mood")?.series).toBeUndefined();
    expect(probed.get("labs")?.series).toBeUndefined();
  });

  it("names a reachable window when the rows are merely older than the scope", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser("reachable");
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 82,
          unit: "kg",
          // 200 days before NOW — outside last90days, inside a year.
          measuredAt: new Date("2026-01-07T07:00:00Z"),
        },
      ],
    });
    const probed = await probeCoachAvailability(
      user.id,
      new Map([["weight", { kind: "measurement", types: ["WEIGHT"] }]]),
      { now: NOW },
    );
    expect(probed.get("weight")?.reachableWithWindow).toBe("lastYear");
  });
});
