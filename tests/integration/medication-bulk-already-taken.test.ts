/**
 * The bulk route the iOS app books every dose through answers a take of a
 * slot that already holds one with `alreadyTaken` (the first take's time and
 * origin), and a dose it records sends the visible confirmation to the
 * owner's other devices. Before, it answered `duplicate` with only the id,
 * so the app booked "done" over a pill box's take without a warning, and
 * the other devices got no confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { DAY_MS, TZ } from "./medication-dose-state-fixtures";

const syncCalls: Array<{ recorded?: unknown }> = [];
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: (arg: { recorded?: unknown }) =>
    syncCalls.push(arg),
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 08:10 in Berlin; the dose is due at 08:00.
const NOW = new Date("2026-11-21T07:10:00.000Z");
const SLOT = new Date("2026-11-21T07:00:00.000Z");

function recordedEvents(): unknown[] {
  return syncCalls.flatMap((c) =>
    Array.isArray(c.recorded) ? c.recorded : c.recorded ? [c.recorded] : [],
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  syncCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "bulk",
      email: "bulk@example.test",
      role: "USER",
      timezone: TZ,
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) },
  });
  cookieJar.set("healthlog_session", session.id);
  const med = await prisma.medication.create({
    data: {
      userId: user.id,
      name: "Ramipril",
      dose: "5 mg",
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
        },
      },
    },
  });
  return { user, medId: med.id };
}

async function bulk(entries: unknown[]) {
  const { POST } = await import("@/app/api/medications/intake/bulk/route");
  const res = await (POST as unknown as (r: NextRequest) => Promise<Response>)(
    new NextRequest("http://localhost/api/medications/intake/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBeLessThan(300);
  return (
    (await res.json()) as {
      data: {
        entries: Array<{
          status: string;
          intake?: Record<string, unknown>;
          takenAt?: string | null;
          takenVia?: string | null;
        }>;
      };
    }
  ).data.entries;
}

describe("bulk intake: one dose per slot, said out loud", () => {
  it("a take over a pill box's take answers alreadyTaken with its time and origin", async () => {
    const { user, medId } = await setup();
    const boxAt = new Date("2026-11-21T07:02:00.000Z");
    await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: user.id,
        medicationId: medId,
        scheduledFor: SLOT,
        takenAt: boxAt,
        source: "API",
        takenVia: "INTEGRATION",
      },
    });
    const [entry] = await bulk([
      {
        medicationId: medId,
        scheduledFor: SLOT.toISOString(),
        takenAt: NOW.toISOString(),
        idempotencyKey: "phone-1",
      },
    ]);
    expect(entry).toMatchObject({
      status: "alreadyTaken",
      takenAt: boxAt.toISOString(),
      takenVia: "INTEGRATION",
      intake: { takenAt: boxAt.toISOString(), takenVia: "INTEGRATION" },
    });
    const rows = await getPrismaClient().medicationIntakeEvent.findMany({
      where: { medicationId: medId, deletedAt: null },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].takenAt?.getTime()).toBe(boxAt.getTime());
    // Nothing recorded, so nothing to confirm.
    expect(recordedEvents()).toHaveLength(0);
  });

  it("a replay of the same key stays duplicate", async () => {
    const { medId } = await setup();
    const entry = {
      medicationId: medId,
      scheduledFor: SLOT.toISOString(),
      takenAt: NOW.toISOString(),
      idempotencyKey: "phone-2",
    };
    expect((await bulk([entry]))[0].status).toMatch(/inserted|updated/);
    expect((await bulk([entry]))[0].status).toBe("duplicate");
  });

  it("a recorded take sends the visible confirmation once for its slot", async () => {
    const { medId } = await setup();
    await bulk([
      {
        medicationId: medId,
        scheduledFor: SLOT.toISOString(),
        takenAt: NOW.toISOString(),
        idempotencyKey: "phone-3",
      },
    ]);
    const recorded = recordedEvents();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      medicationId: medId,
      outcome: "taken",
      takenVia: "APP",
    });
  });
});
