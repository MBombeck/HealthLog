/**
 * Garmin's period end lands only on a cycle Garmin's own day opened
 * (real Postgres).
 *
 * The hourly Garmin leg stamps the last day of a finished period on the cycle
 * that starts on Garmin's start date. A cycle the person opened herself on
 * that date carries her own account of the period: her days, her end or none
 * yet. Garmin fills only the days no row covers, and it does not write her
 * cycle's period end either.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { writeGarminPeriod } from "@/lib/garmin/cycle-sync";

const GARMIN_OPENED = "user-garmin-stamp-own";
const PERSON_OPENED = "user-garmin-stamp-person";

const START = "2026-09-01";
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];

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

async function cycleAt(userId: string) {
  return getPrismaClient().menstrualCycle.findFirstOrThrow({
    where: { userId, startDate: START, deletedAt: null },
    select: { id: true, periodEndDate: true },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await seedUser(GARMIN_OPENED);
  await seedUser(PERSON_OPENED);
});

describe("Garmin period end", () => {
  it("stamps the end on the cycle Garmin's first day opened", async () => {
    await writeGarminPeriod(GARMIN_OPENED, {
      start: START,
      days: DAYS,
      ended: true,
    });
    expect(await cycleAt(GARMIN_OPENED)).toMatchObject({
      periodEndDate: "2026-09-04",
    });
  });

  it("leaves the period end of a cycle the person opened to her", async () => {
    const prisma = getPrismaClient();
    // She tapped her start: the cycle and her own first day.
    const cycle = await prisma.menstrualCycle.create({
      data: { userId: PERSON_OPENED, startDate: START, tz: "UTC" },
    });
    await prisma.cycleDayLog.create({
      data: {
        userId: PERSON_OPENED,
        date: START,
        tz: "UTC",
        source: "MANUAL",
        flow: "MEDIUM",
        cycleId: cycle.id,
      },
    });

    // Every hourly tick after the period is over writes the same thing.
    for (let tick = 0; tick < 2; tick++) {
      await writeGarminPeriod(PERSON_OPENED, {
        start: START,
        days: DAYS,
        ended: true,
      });
    }
    expect(await cycleAt(PERSON_OPENED)).toMatchObject({
      id: cycle.id,
      periodEndDate: null,
    });
    // Garmin still filled the days she did not log.
    expect(
      await prisma.cycleDayLog.count({
        where: { userId: PERSON_OPENED, source: "GARMIN", cycleId: cycle.id },
      }),
    ).toBe(3);
  });
});
