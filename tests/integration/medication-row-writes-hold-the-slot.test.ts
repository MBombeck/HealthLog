/**
 * The writes that address one intake row by id (the status route and the
 * per-event edit) hold the slot like every other writer.
 *
 * - A take or a skip that reaches a row an undo tombstoned meanwhile answers
 *   404 and writes nothing. It used to write onto the tombstone and answer
 *   200 while the dose was gone.
 * - A take or an edit that would move the dose onto a slot that already
 *   holds a take is refused with 422 `medications.intake.force_slot.occupied`
 *   and changes nothing. It used to tombstone the source row, find the
 *   target taken, answer 200, and the moved dose was lost with its stock
 *   refunded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import {
  DAY_MS,
  TZ,
  eventPut,
  statusPost,
} from "./medication-dose-state-fixtures";

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: () => {},
}));
vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

// 13:30 in Berlin. Doses at 08:00 and 13:00; the pill box took the 13:00 one.
const NOW = new Date("2026-11-21T12:30:00.000Z");
const MORNING = new Date("2026-11-21T07:00:00.000Z");
const MIDDAY = new Date("2026-11-21T12:00:00.000Z");
const BOX_AT = new Date("2026-11-21T12:02:00.000Z");

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function setup(morning: { takenAt: Date | null }) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "rowwrites",
      email: "rowwrites@example.test",
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
          timesOfDay: ["08:00", "13:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  const morningRow = await prisma.medicationIntakeEvent.create({
    data: {
      userId: user.id,
      medicationId: med.id,
      scheduledFor: MORNING,
      takenAt: morning.takenAt,
      source: "WEB",
      ...(morning.takenAt && { takenVia: "WEB" as const }),
    },
  });
  const middayTake = await prisma.medicationIntakeEvent.create({
    data: {
      userId: user.id,
      medicationId: med.id,
      scheduledFor: MIDDAY,
      takenAt: BOX_AT,
      source: "API",
      takenVia: "INTEGRATION",
      idempotencyKey: "box-1",
    },
  });
  return { medId: med.id, morningRow, middayTake };
}

async function errorCode(res: Response) {
  return ((await res.json()) as { meta?: { errorCode?: string } }).meta
    ?.errorCode;
}

async function expectUnchanged(
  morningId: string,
  morningTakenAt: Date | null,
  middayId: string,
) {
  const prisma = getPrismaClient();
  const morning = await prisma.medicationIntakeEvent.findUniqueOrThrow({
    where: { id: morningId },
  });
  expect(morning.deletedAt).toBeNull();
  expect(morning.scheduledFor.getTime()).toBe(MORNING.getTime());
  expect(morning.takenAt?.getTime() ?? null).toBe(
    morningTakenAt?.getTime() ?? null,
  );
  const midday = await prisma.medicationIntakeEvent.findUniqueOrThrow({
    where: { id: middayId },
  });
  expect(midday).toMatchObject({ deletedAt: null, takenVia: "INTEGRATION" });
  expect(midday.takenAt?.getTime()).toBe(BOX_AT.getTime());
}

describe("writes by row id hold the slot", () => {
  it("a take reaching a row an undo tombstoned answers 404 and writes nothing", async () => {
    const { morningRow } = await setup({ takenAt: null });
    const { findIntakeForStatusUpdate } =
      await import("@/lib/medications/update-intake-status/admission");
    const { updateIntakeStatus } =
      await import("@/lib/medications/update-intake-status/update-intake-status");
    const prisma = getPrismaClient();
    const user = await prisma.user.findFirstOrThrow();
    // The route read the row; the undo commits before the write.
    const existing = await findIntakeForStatusUpdate({
      userId: user.id,
      intakeId: morningRow.id,
    });
    expect(existing).not.toBeNull();
    await prisma.medicationIntakeEvent.update({
      where: { id: morningRow.id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });
    for (const status of ["taken", "skipped"] as const) {
      const outcome = await updateIntakeStatus(
        {
          user: { id: user.id, timezone: TZ },
          actorId: user.id,
          existing: existing!,
          ipAddress: null,
          originDeviceToken: null,
          takenVia: "WEB",
        },
        { intakeId: morningRow.id, status },
      );
      expect(outcome).toMatchObject({ kind: "refused", status: 404 });
    }
    const row = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: morningRow.id },
    });
    expect(row.takenAt).toBeNull();
    expect(row.skipped).toBe(false);
  });

  it("a status take pinned onto a taken slot is refused and loses nothing", async () => {
    const { morningRow, middayTake } = await setup({ takenAt: null });
    const res = await statusPost({
      intakeId: morningRow.id,
      status: "taken",
      forceSlotInstant: MIDDAY.toISOString(),
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("medications.intake.force_slot.occupied");
    await expectUnchanged(morningRow.id, null, middayTake.id);
  });

  it("an edit that moves a taken dose onto a taken slot is refused and loses nothing", async () => {
    const morningAt = new Date("2026-11-21T07:02:00.000Z");
    const { medId, morningRow, middayTake } = await setup({
      takenAt: morningAt,
    });
    // The corrected time falls in the midday band, which the pill box holds.
    const res = await eventPut(medId, morningRow.id, {
      takenAt: new Date("2026-11-21T12:01:00.000Z").toISOString(),
    });
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("medications.intake.force_slot.occupied");
    await expectUnchanged(morningRow.id, morningAt, middayTake.id);
  });
});
