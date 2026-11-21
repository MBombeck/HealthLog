/**
 * The today list publishes each dose's resolved state, from the same bands
 * the dose history and the reminders use, so a client renders it instead of
 * re-deriving windows with fixed thresholds. A medication's stored dose
 * window moves the instants (C-L8: the window shown is the window stored).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { DAY_MS, TZ, readToday } from "./medication-dose-state-fixtures";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 08:00 Berlin = 07:00Z on 2026-11-21.
const SLOT = new Date("2026-11-21T07:00:00.000Z");

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(
  doseWindows?: unknown,
  legacy?: { windowStart: string; windowEnd: string },
) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "resolved",
      email: "resolved@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 2 * DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Resolved",
      dose: "1",
      active: true,
      startsOn: new Date(Date.now() - 30 * DAY_MS),
      createdAt: new Date(Date.now() - 30 * DAY_MS),
      schedules: {
        create: {
          windowStart: legacy?.windowStart ?? "08:00",
          windowEnd: legacy?.windowEnd ?? "08:00",
          timesOfDay: legacy ? [] : ["08:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
          ...(doseWindows !== undefined && {
            doseWindows: doseWindows as never,
          }),
        },
      },
    },
  });
  return { user, medId: med.id };
}

async function slotRow() {
  const rows = await readToday();
  return rows.find(
    (r) => new Date(r.scheduledAt).getTime() === SLOT.getTime(),
  ) as Record<string, unknown> | undefined;
}

function at(iso: string) {
  vi.useFakeTimers({ now: new Date(iso), toFake: ["Date"] });
}

describe("today list: resolved dose state", () => {
  it("moves upcoming, due, overdue, missed with the clock and says a late take counts", async () => {
    at("2026-11-21T05:00:00.000Z");
    // 07:30 to 10:00 Berlin is the stored on-time window.
    await setup([{ timeOfDay: "08:00", start: "07:30", end: "10:00" }]);
    const row = (await slotRow())!;
    expect(row).toMatchObject({
      state: "upcoming",
      takenLate: false,
      slotInstant: SLOT.toISOString(),
      dueAt: "2026-11-21T06:30:00.000Z",
      overdueSince: null,
      lateTakeCounts: false,
    });
    const missedAfter = Date.parse(row.missedAfter as string);
    expect(missedAfter).toBeGreaterThan(Date.parse("2026-11-21T09:00:00.000Z"));

    at("2026-11-21T06:31:00.000Z");
    expect((await slotRow())?.state).toBe("due");
    at("2026-11-21T09:01:00.000Z");
    expect(await slotRow()).toMatchObject({
      state: "overdue",
      overdueSince: "2026-11-21T09:00:00.000Z",
    });
    at(new Date(missedAfter + 60_000).toISOString());
    expect(await slotRow()).toMatchObject({
      state: "missed",
      overdueSince: null,
      lateTakeCounts: true,
    });
  });

  it("reads taken with where it came from", async () => {
    at("2026-11-21T07:05:00.000Z");
    const { user, medId } = await setup();
    await readToday();
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { userId: user.id, medicationId: medId, scheduledFor: SLOT },
      data: {
        takenAt: new Date("2026-11-21T07:02:00.000Z"),
        takenVia: "INTEGRATION",
      },
    });
    expect(await slotRow()).toMatchObject({
      state: "taken",
      takenVia: "INTEGRATION",
      takenAt: "2026-11-21T07:02:00.000Z",
    });
  });

  it("a take after the on-time window reads taken, late", async () => {
    at("2026-11-21T10:00:00.000Z");
    const { user, medId } = await setup();
    await readToday();
    await getPrismaClient().medicationIntakeEvent.updateMany({
      where: { userId: user.id, medicationId: medId, scheduledFor: SLOT },
      data: { takenAt: new Date("2026-11-21T09:30:00.000Z") },
    });
    expect(await slotRow()).toMatchObject({ state: "taken", takenLate: true });
  });

  it("a legacy schedule's stored window is the window the dose reads (C-L8)", async () => {
    at("2026-11-21T09:30:00.000Z");
    // Stored 08:00 to 10:00 Berlin, no times_of_day: 10:30 is past it.
    await setup(undefined, { windowStart: "08:00", windowEnd: "10:00" });
    const row = (await slotRow())!;
    expect(row).toMatchObject({
      state: "overdue",
      dueAt: "2026-11-21T07:00:00.000Z",
      overdueSince: "2026-11-21T09:00:00.000Z",
    });
  });
});
