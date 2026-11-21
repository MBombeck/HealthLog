/**
 * One slot, one decision, whatever writes it and however close together.
 *
 * Every take path ends in `applyCanonicalSlotWrite` (per-medication route,
 * bulk and iOS, the ingest hook, Telegram). Without a lock two writers that
 * both read an empty slot each inserted a row when their sources differed; a
 * second take overwrote the first one's time and idempotency key; an undo of
 * a tap that had converged onto a pill box's take removed the pill box's
 * dose; and a take racing an undo could land on the tombstone and report
 * success. A lost take reopens the slot and every channel reminds again.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import { applyCanonicalSlotWrite } from "@/lib/medications/scheduling/slot-upsert";
import { deleteIntakeEvent } from "@/lib/medications/delete-intake-event";
import { localHmAsUtc } from "@/lib/tz/local-day";

const USER = "user-slot-write-races";
const TZ = "Europe/Berlin";
const DAY = new Date("2026-03-10T12:00:00.000Z");
const SLOT = localHmAsUtc(DAY, TZ, 8, 0);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: USER,
      username: "slot-races",
      email: "slot-races@example.test",
      timezone: TZ,
    },
  });
});

async function med(): Promise<string> {
  const m = await getPrismaClient().medication.create({
    data: {
      userId: USER,
      name: "Ramipril",
      dose: "5mg",
      active: true,
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
  return m.id;
}

function take(
  medicationId: string,
  takenAt: Date,
  source: "WEB" | "API" | "REMINDER",
  key: string,
) {
  return applyCanonicalSlotWrite({
    client: getPrismaClient(),
    userId: USER,
    medicationId,
    canonicalSlot: SLOT,
    takenAt,
    skipped: false,
    isExplicitTaken: true,
    isExplicitSkip: false,
    idempotencyKey: key,
    createSource: source,
    attributionSource: "AUTO",
  });
}

async function undo(
  medicationId: string,
  eventId: string,
  expect: { expectedSyncVersion?: number; expectedIdempotencyKey?: string },
) {
  const event = await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow(
    { where: { id: eventId } },
  );
  return deleteIntakeEvent({
    user: { id: USER, timezone: TZ },
    medicationId,
    eventId,
    event,
    ...expect,
    ipAddress: "127.0.0.1",
    originDeviceToken: null,
  });
}

async function live(medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { userId: USER, medicationId, deletedAt: null },
  });
}

describe("one slot, one decision", () => {
  it("a second take keeps the first take, its time and its key, and says alreadyTaken", async () => {
    const id = await med();
    const boxAt = new Date(SLOT.getTime() + 60_000);
    const box = await take(id, boxAt, "API", "box-1");
    const phone = await take(id, SLOT, "API", "phone-1");
    expect(phone.alreadyTaken).toBe(true);
    expect(phone.consumedTransition).toBe(false);
    expect(phone.row.id).toBe(box.row.id);
    const rows = await live(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].takenAt?.getTime()).toBe(boxAt.getTime());
    expect(rows[0].idempotencyKey).toBe("box-1");
    // A retry of the first request still finds its own key.
    const retry = await take(id, boxAt, "API", "box-1");
    expect(retry.row.id).toBe(box.row.id);
    expect((await live(id))[0].takenAt?.getTime()).toBe(boxAt.getTime());
  });

  it("two writers of different sources at once leave one live row and one consumed take", async () => {
    const id = await med();
    const results = await Promise.all([
      take(id, new Date(SLOT.getTime() + 60_000), "API", "box-2"),
      take(id, SLOT, "REMINDER", "tg-2"),
      take(id, new Date(SLOT.getTime() + 30_000), "WEB", "web-2"),
    ]);
    const rows = await live(id);
    expect(rows).toHaveLength(1);
    expect(results.filter((r) => r.consumedTransition)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyTaken)).toHaveLength(2);
  });

  it("two writers onto a pending row at once: exactly one moves it to taken", async () => {
    const id = await med();
    await getPrismaClient().medicationIntakeEvent.create({
      data: {
        userId: USER,
        medicationId: id,
        scheduledFor: SLOT,
        source: "REMINDER",
      },
    });
    const [a, b] = await Promise.all([
      take(id, new Date(SLOT.getTime() + 60_000), "API", "box-4"),
      take(id, SLOT, "API", "phone-4"),
    ]);
    expect(await live(id)).toHaveLength(1);
    expect([a.consumedTransition, b.consumedTransition].sort()).toEqual([
      false,
      true,
    ]);
  });

  it("the database refuses a second live row for one slot from another source", async () => {
    const id = await med();
    const prisma = getPrismaClient();
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: USER,
        medicationId: id,
        scheduledFor: SLOT,
        source: "API",
      },
    });
    await expect(
      prisma.medicationIntakeEvent.create({
        data: {
          userId: USER,
          medicationId: id,
          scheduledFor: SLOT,
          source: "REMINDER",
        },
      }),
    ).rejects.toThrow();
  });
});

describe("undo against takes", () => {
  it("undoing a tap that converged onto a pill box's take leaves the pill box's dose", async () => {
    const id = await med();
    await take(id, new Date(SLOT.getTime() + 60_000), "API", "box");
    const phone = await take(id, SLOT, "API", "phone");
    expect(phone.alreadyTaken).toBe(true);
    const verdict = await undo(id, phone.row.id, {
      expectedIdempotencyKey: "phone",
    });
    expect(verdict).toBe("changedSinceSeen");
    const rows = await live(id);
    expect(rows.filter((r) => r.takenAt !== null)).toHaveLength(1);
  });

  it("an undo of a version that has changed since is refused", async () => {
    const id = await med();
    const first = await take(id, SLOT, "WEB", "web-v");
    const seen = first.row.syncVersion;
    // Another writer changes the row: a correction through the row id (a
    // stale skip through the slot answers alreadyTaken and changes nothing).
    await getPrismaClient().medicationIntakeEvent.update({
      where: { id: first.row.id },
      data: { takenAt: null, skipped: true, syncVersion: { increment: 1 } },
    });
    expect(await undo(id, first.row.id, { expectedSyncVersion: seen })).toBe(
      "changedSinceSeen",
    );
    expect(await live(id)).toHaveLength(1);
  });

  it("a take racing an undo never reports a dose that is not live", async () => {
    const id = await med();
    const first = await take(id, SLOT, "WEB", "web-r");
    const [, second] = await Promise.all([
      undo(id, first.row.id, { expectedSyncVersion: first.row.syncVersion }),
      take(id, new Date(SLOT.getTime() + 30_000), "API", "box-r"),
    ]);
    const after =
      await getPrismaClient().medicationIntakeEvent.findUniqueOrThrow({
        where: { id: second.row.id },
      });
    if (second.alreadyTaken) {
      // The take came first and found the web take; the undo then removed
      // that one row, which is the undo the person asked for.
      expect(after.id).toBe(first.row.id);
    } else {
      // The undo came first; the take wrote a live row of its own.
      expect(after.deletedAt).toBeNull();
      expect(after.takenAt).not.toBeNull();
    }
  });
});
