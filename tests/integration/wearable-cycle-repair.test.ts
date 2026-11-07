/**
 * The one-shot repair of wearable period days imported without the cycles
 * they open (real Postgres).
 *
 * Garmin and Oura used to write their period days as bare rows, so an
 * account whose periods came from a watch or a ring held day-logs and no
 * cycle. The repair opens the cycles those rows start, attributes the rest,
 * stamps the end of a finished Garmin period, and touches no day-log's own
 * content. A day the cycle rule declines stays as it is and drops out of the
 * candidate set, so the boot check converges; a second run changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const sends = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    send: async (queue: string) => {
      sends.push(queue);
      return `job-${sends.length}`;
    },
  }),
}));

import { removeCycleStartedOn } from "@/lib/cycle/cycle-boundaries";
import {
  enqueueBootTimeWearableCycleRepair,
  repairWearableCycleDays,
} from "@/lib/jobs/wearable-cycle-repair";

const GARMIN_USER = "user-wearable-repair-garmin";
const OURA_USER = "user-wearable-repair-oura";
const BLOCKED_USER = "user-wearable-repair-blocked";
const OFF_USER = "user-wearable-repair-off";

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);

const GARMIN_STARTS = ["2026-07-01", "2026-07-29", "2026-08-26"];

async function seedUser(id: string) {
  await getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: "UTC",
      gender: "FEMALE",
    },
  });
}

/** Day-logs as a v1.47.0 import left them: no cycle. */
async function orphanDays(
  userId: string,
  source: "GARMIN" | "OURA",
  days: string[],
) {
  await getPrismaClient().cycleDayLog.createMany({
    data: days.map((date) => ({
      userId,
      date,
      tz: "UTC",
      source,
      flow: "LIGHT" as const,
    })),
  });
}

async function liveCycles(userId: string) {
  return getPrismaClient().menstrualCycle.findMany({
    where: { userId, deletedAt: null },
    orderBy: { startDate: "asc" },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      lengthDays: true,
      periodEndDate: true,
      syncVersion: true,
    },
  });
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  sends.length = 0;
  for (const id of [GARMIN_USER, OURA_USER, BLOCKED_USER]) await seedUser(id);

  await orphanDays(
    GARMIN_USER,
    "GARMIN",
    GARMIN_STARTS.flatMap((start) =>
      [0, 1, 2, 3, 4].map((i) => addDays(start, i)),
    ).filter((d) => d !== "2026-07-31"),
  );
  // The person's own day inside the middle period, logged before any cycle.
  await prisma.cycleDayLog.create({
    data: {
      userId: GARMIN_USER,
      date: "2026-07-31",
      flow: "HEAVY",
      source: "MANUAL",
    },
  });

  await orphanDays(OURA_USER, "OURA", ["2026-06-01", "2026-06-29"]);

  // A Garmin day 15 days before a start the person tapped: too close to be a
  // cycle of its own, too far to be the same period. The rule declines it.
  await prisma.menstrualCycle.create({
    data: { userId: BLOCKED_USER, startDate: "2026-09-16", tz: "UTC" },
  });
  await orphanDays(BLOCKED_USER, "GARMIN", ["2026-09-01"]);
});

describe("wearable cycle repair", () => {
  it("gives orphaned wearable period days their cycles", async () => {
    expect(await enqueueBootTimeWearableCycleRepair()).toEqual({
      enqueued: true,
      error: null,
    });

    const result = await repairWearableCycleDays();
    expect(result).toMatchObject({ opened: 5, periodEnds: 2, accounts: 2 });

    const garmin = await liveCycles(GARMIN_USER);
    expect(
      garmin.map((c) => [
        c.startDate,
        c.endDate,
        c.lengthDays,
        c.periodEndDate,
      ]),
    ).toEqual([
      ["2026-07-01", "2026-07-28", 28, "2026-07-05"],
      // The person's day breaks the Garmin run, so the end is the day before.
      ["2026-07-29", "2026-08-25", 28, "2026-07-30"],
      // Still open: the hourly sync stamps its end.
      ["2026-08-26", null, null, null],
    ]);
    const prisma = getPrismaClient();
    const days = await prisma.cycleDayLog.findMany({
      where: { userId: GARMIN_USER },
      orderBy: { date: "asc" },
    });
    for (const day of days) {
      const owner = [...garmin].reverse().find((c) => c.startDate <= day.date);
      expect(day.cycleId).toBe(owner!.id);
    }
    expect(days.find((d) => d.date === "2026-07-31")).toMatchObject({
      source: "MANUAL",
      flow: "HEAVY",
    });

    const oura = await liveCycles(OURA_USER);
    expect(oura.map((c) => [c.startDate, c.lengthDays])).toEqual([
      ["2026-06-01", 28],
      ["2026-06-29", null],
    ]);

    // The declined day stays as it was and no longer counts as work.
    const blocked = await prisma.cycleDayLog.findFirst({
      where: { userId: BLOCKED_USER },
    });
    expect(blocked?.cycleId).toBeNull();
    expect(await liveCycles(BLOCKED_USER)).toHaveLength(1);

    sends.length = 0;
    expect(await enqueueBootTimeWearableCycleRepair()).toEqual({
      enqueued: false,
      error: null,
    });
    expect(sends).toEqual([]);
  });

  it("changes nothing on a second run", async () => {
    await repairWearableCycleDays();
    const before = await liveCycles(GARMIN_USER);
    const daysBefore = await getPrismaClient().cycleDayLog.findMany({
      where: { userId: GARMIN_USER },
      orderBy: { date: "asc" },
      select: { id: true, cycleId: true, syncVersion: true, flow: true },
    });
    const again = await repairWearableCycleDays();
    expect(again).toMatchObject({ scanned: 0, opened: 0, attributed: 0 });
    expect(await liveCycles(GARMIN_USER)).toEqual(before);
    expect(
      await getPrismaClient().cycleDayLog.findMany({
        where: { userId: GARMIN_USER },
        orderBy: { date: "asc" },
        select: { id: true, cycleId: true, syncVersion: true, flow: true },
      }),
    ).toEqual(daysBefore);
  });

  it("never reopens a cycle the person deleted", async () => {
    const prisma = getPrismaClient();
    await repairWearableCycleDays();
    // The cycle delete: the first cycle goes, and with nothing before it
    // its Garmin days are left without a cycle.
    await prisma.$transaction((db) =>
      removeCycleStartedOn(db, GARMIN_USER, "2026-07-01"),
    );
    const orphaned = await prisma.cycleDayLog.count({
      where: { userId: GARMIN_USER, cycleId: null, deletedAt: null },
    });
    expect(orphaned).toBe(5);

    sends.length = 0;
    expect(await enqueueBootTimeWearableCycleRepair()).toEqual({
      enqueued: false,
      error: null,
    });
    expect(await repairWearableCycleDays()).toMatchObject({
      scanned: 0,
      opened: 0,
    });
    expect((await liveCycles(GARMIN_USER)).map((c) => c.startDate)).toEqual([
      "2026-07-29",
      "2026-08-26",
    ]);
  });

  it("does not move the start to the next day when the first day is deleted", async () => {
    const prisma = getPrismaClient();
    await repairWearableCycleDays();
    // The day-log delete: the opening day goes, and its cycle with it.
    const first = await prisma.cycleDayLog.findFirstOrThrow({
      where: { userId: GARMIN_USER, date: "2026-07-01" },
    });
    await prisma.$transaction(async (db) => {
      await db.cycleDayLog.update({
        where: { id: first.id },
        data: { deletedAt: new Date() },
      });
      return removeCycleStartedOn(db, GARMIN_USER, "2026-07-01");
    });

    await repairWearableCycleDays();
    expect((await liveCycles(GARMIN_USER)).map((c) => c.startDate)).toEqual([
      "2026-07-29",
      "2026-08-26",
    ]);
  });

  it("leaves an account with cycle tracking off alone", async () => {
    const prisma = getPrismaClient();
    await seedUser(OFF_USER);
    await prisma.cycleProfile.create({
      data: { userId: OFF_USER, cycleTrackingEnabled: false },
    });
    await orphanDays(OFF_USER, "GARMIN", ["2026-07-01", "2026-07-02"]);

    const result = await repairWearableCycleDays();
    expect(result.accounts).toBe(2);
    expect(await liveCycles(OFF_USER)).toEqual([]);
    expect(
      await prisma.cycleDayLog.count({
        where: { userId: OFF_USER, cycleId: null },
      }),
    ).toBe(2);

    // Its rows are no work while the module is off: the boot stays quiet.
    sends.length = 0;
    expect(await enqueueBootTimeWearableCycleRepair()).toEqual({
      enqueued: false,
      error: null,
    });
  });
});
