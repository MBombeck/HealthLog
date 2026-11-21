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

async function setup(doseWindows?: unknown) {
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
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
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
  it("moves pending, due, overdue, missed with the clock and says a late take counts", async () => {
    at("2026-11-21T05:00:00.000Z");
    await setup();
    expect(await slotRow()).toMatchObject({
      state: "pending",
      slotInstant: SLOT.toISOString(),
      lateTakeCounts: false,
    });
    const row = (await slotRow())!;
    const dueAt = Date.parse(row.dueAt as string);
    const overdueSince = Date.parse(row.overdueSince as string);
    const missedAfter = Date.parse(row.missedAfter as string);
    expect(dueAt).toBeLessThanOrEqual(SLOT.getTime());
    expect(overdueSince).toBeGreaterThan(SLOT.getTime());
    expect(missedAfter).toBeGreaterThan(overdueSince);

    at(new Date(dueAt + 60_000).toISOString());
    expect((await slotRow())?.state).toBe("due");
    at(new Date(overdueSince + 60_000).toISOString());
    expect((await slotRow())?.state).toBe("overdue");
    at(new Date(missedAfter + 60_000).toISOString());
    expect(await slotRow()).toMatchObject({
      state: "missed",
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

  it("a stored dose window sets the instants the list shows", async () => {
    at("2026-11-21T05:00:00.000Z");
    await setup([{ timeOfDay: "08:00", start: "07:30", end: "10:00" }]);
    const row = (await slotRow())!;
    // 07:30 and 10:00 Berlin.
    expect(row.dueAt).toBe("2026-11-21T06:30:00.000Z");
    expect(row.overdueSince).toBe("2026-11-21T09:00:00.000Z");
  });
});
