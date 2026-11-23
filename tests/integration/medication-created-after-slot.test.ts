/**
 * A dose whose time had already passed when the medication was created is not
 * owed. The list used to call it overdue while the dose ledger (and so the
 * today rows' state and `currentDose`) had no slot for it at all. Now every
 * surface says the same: nothing today, the next dose tomorrow, upcoming. A
 * dose whose time is still ahead at creation is owed, even when its window had
 * already opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { DAY_MS, TZ, readToday } from "./medication-dose-state-fixtures";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => undefined,
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 09:30 in Berlin. The dose is at 08:00: on time 07:00-09:00, overdue now.
const NOW = new Date("2026-11-21T08:30:00.000Z");
const SLOT = new Date("2026-11-21T07:00:00.000Z");
const TOMORROW = new Date(SLOT.getTime() + DAY_MS);
let counter = 0;

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A user and a daily 08:00 medication created at `createdAt`. */
async function setup(createdAt: Date) {
  const prisma = getPrismaClient();
  const s = `created-after-${counter++}`;
  const user = await prisma.user.create({
    data: {
      username: s,
      email: `${s}@example.test`,
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(NOW.getTime() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Ramipril",
      dose: "5 mg",
      active: true,
      createdAt,
      schedules: {
        create: {
          windowStart: "08:00",
          windowEnd: "08:00",
          timesOfDay: ["08:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return med.id;
}

type Plain = (r: NextRequest) => Promise<Response>;

async function surfaces(medId: string) {
  const { GET: list } = await import("@/app/api/medications/route");
  const listed = (
    (await (
      await (list as unknown as Plain)(
        new NextRequest("http://localhost/api/medications"),
      )
    ).json()) as {
      data: Array<{ id: string; nextDueAt: string; nextDueOverdue: boolean }>;
    }
  ).data.find((m) => m.id === medId);
  const { GET: compliance } =
    await import("@/app/api/medications/compliance/route");
  const dose = (
    (await (
      await (compliance as unknown as Plain)(
        new NextRequest("http://localhost/api/medications/compliance"),
      )
    ).json()) as {
      data: Array<{
        medicationId: string;
        complianceDisplay: {
          currentDose: { targetAt: string | null; state: string | null };
        };
      }>;
    }
  ).data.find((r) => r.medicationId === medId)?.complianceDisplay.currentDose;
  const today = (await readToday()).filter((r) => r.medicationId === medId);
  return { listed, dose, today };
}

describe("a dose whose time passed before the medication was created", () => {
  it.each([
    ["after its window closed", new Date("2026-11-21T08:15:00.000Z")],
    [
      "inside its window, after the dose time",
      new Date("2026-11-21T07:30:00.000Z"),
    ],
  ])(
    "is not owed when created %s: next dose tomorrow, upcoming",
    async (_, createdAt) => {
      const medId = await setup(createdAt);
      const { listed, dose, today } = await surfaces(medId);
      expect(listed?.nextDueAt).toBe(TOMORROW.toISOString());
      expect(listed?.nextDueOverdue).toBe(false);
      expect(dose).toMatchObject({
        targetAt: TOMORROW.toISOString(),
        state: "upcoming",
      });
      // Nothing projected for today.
      expect(today).toEqual([]);
    },
  );

  it("is owed when created inside its window before the dose time", async () => {
    const medId = await setup(new Date("2026-11-21T06:30:00.000Z"));
    const { listed, dose, today } = await surfaces(medId);
    expect(listed?.nextDueAt).toBe(SLOT.toISOString());
    expect(listed?.nextDueOverdue).toBe(true);
    expect(dose).toMatchObject({
      targetAt: SLOT.toISOString(),
      state: "overdue",
    });
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({
      scheduledAt: SLOT.toISOString(),
      state: "overdue",
    });
  });
});
