/**
 * The Today medications total against real Postgres: which of the day's
 * intake rows count as scheduled doses (`buildMedsTodayBlock`).
 *
 *   - an as-needed medication schedules nothing, so its ad-hoc intakes
 *     (`scheduledFor === takenAt`) are neither scheduled nor taken doses of
 *     the day;
 *   - a medication paused earlier in the day keeps the dose it took, but its
 *     still-pending placeholders leave the total.
 *
 * Mutation checks (each seen red): drop `asNeeded: false` from the tally
 * filter → the first case counts 2; drop the `active` arm → the second counts
 * the evening placeholder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMedsTodayBlock } from "@/lib/dashboard/meds-today";

import { getPrismaClient, truncateAllTables } from "./setup";

const TZ = "Europe/Berlin";
// 13:00 in Berlin (CEST).
const NOW = new Date("2026-06-10T11:00:00.000Z");
let counter = 0;

async function makeUser(): Promise<string> {
  const suffix = `${counter++}`;
  const user = await getPrismaClient().user.create({
    data: {
      username: `meds-total-${suffix}`,
      email: `meds-total-${suffix}@example.test`,
      timezone: TZ,
      locale: "en",
    },
  });
  return user.id;
}

async function seedDaily(userId: string, timesOfDay: string[]) {
  return getPrismaClient().medication.create({
    data: {
      userId,
      name: "Daily",
      dose: "1 tablet",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      schedules: {
        create: {
          windowStart: timesOfDay[0],
          windowEnd: timesOfDay[0],
          timesOfDay,
          rrule: "FREQ=DAILY",
          scheduleType: "SCHEDULED",
        },
      },
    },
    select: { id: true },
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the Today medications total", () => {
  it("leaves as-needed intakes out", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const daily = await seedDaily(userId, ["08:00"]);
    const prn = await prisma.medication.create({
      data: {
        userId,
        name: "As needed",
        dose: "1 tablet",
        asNeeded: true,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      },
      select: { id: true },
    });
    await buildMedsTodayBlock(prisma, userId, TZ, NOW);
    await prisma.medicationIntakeEvent.updateMany({
      where: { medicationId: daily.id },
      data: { takenAt: new Date("2026-06-10T06:05:00.000Z") },
    });
    const adHoc = new Date("2026-06-10T09:30:00.000Z");
    await prisma.medicationIntakeEvent.create({
      data: {
        userId,
        medicationId: prn.id,
        scheduledFor: adHoc,
        takenAt: adHoc,
      },
    });

    const block = await buildMedsTodayBlock(prisma, userId, TZ, NOW);
    expect(block.scheduledToday).toBe(1);
    expect(block.takenToday).toBe(1);
    expect(block.scheduledTodayAt).toEqual(["2026-06-10T06:00:00.000Z"]);
  });

  it("drops the pending doses of a medication paused earlier today", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser();
    const paused = await seedDaily(userId, ["08:00", "20:00"]);
    await buildMedsTodayBlock(prisma, userId, TZ, NOW);
    await prisma.medicationIntakeEvent.updateMany({
      where: {
        medicationId: paused.id,
        scheduledFor: new Date("2026-06-10T06:00:00.000Z"),
      },
      data: { takenAt: new Date("2026-06-10T06:05:00.000Z") },
    });
    expect(
      (await buildMedsTodayBlock(prisma, userId, TZ, NOW)).scheduledToday,
    ).toBe(2);
    await prisma.medication.update({
      where: { id: paused.id },
      data: { active: false, pausedAt: NOW },
    });

    const block = await buildMedsTodayBlock(prisma, userId, TZ, NOW);
    expect(block.scheduledToday).toBe(1);
    expect(block.takenToday).toBe(1);
    expect(block.scheduledTodayAt).toEqual(["2026-06-10T06:00:00.000Z"]);
  });
});
