/**
 * v1.12.3 — per-dose intake targeting via the supplied `scheduledFor`.
 *
 * Closes the "morning auto-taken" bug: the web medication card now threads
 * the displayed dose's canonical slot instant onto the intake POST as
 * `scheduledFor`, so the server records THAT slot rather than snapping
 * "now" to the nearest one. These tests exercise the exact server path the
 * route runs for a supplied `scheduledFor` — `resolveSlotInstantForWrite`
 * (the canonical snap) feeding `applyCanonicalSlotWrite` — on real Postgres,
 * for a twice-daily 07:00 / 19:00 medication.
 *
 * Proven invariants:
 *   1. A `scheduledFor` in the morning capture zone resolves + writes the
 *      07:00 slot; one in the evening zone resolves + writes the 19:00 slot
 *      — driven by the SUPPLIED instant, never the wall-clock.
 *   2. Marking the morning dose does NOT mark the evening dose (the evening
 *      slot stays pending) and vice-versa.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import {
  applyCanonicalSlotWrite,
  resolveSlotInstantForWrite,
} from "@/lib/medications/scheduling/slot-upsert";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TEST_USER_ID = "user-intake-scheduledfor-targeting";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "intake-sf-targeting",
      email: "intake-sf-targeting@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

// Fixed non-DST-boundary weekday so the slot instants are deterministic.
const DAY = new Date("2026-03-10T12:00:00.000Z");

async function createTwiceDailyMed(): Promise<string> {
  const prisma = getPrismaClient();
  const med = await prisma.medication.create({
    data: {
      userId: TEST_USER_ID,
      name: "Bisoprolol",
      dose: "2.5mg",
      active: true,
      schedules: {
        create: {
          windowStart: "07:00",
          windowEnd: "19:00",
          timesOfDay: ["07:00", "19:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return med.id;
}

/** Mimic the route: snap the supplied `scheduledFor`, then upsert the slot. */
async function recordViaSchedule(medId: string, scheduledFor: Date) {
  const prisma = getPrismaClient();
  const canonicalSlot = await resolveSlotInstantForWrite({
    userId: TEST_USER_ID,
    medicationId: medId,
    userTz: "Europe/Berlin",
    incoming: scheduledFor,
  });
  expect(canonicalSlot).not.toBeNull();
  const takenAt = new Date(); // "now" — the recording moment, NOT the slot.
  const applied = await applyCanonicalSlotWrite({
    client: prisma,
    userId: TEST_USER_ID,
    medicationId: medId,
    canonicalSlot: canonicalSlot!,
    takenAt,
    skipped: false,
    isExplicitTaken: true,
    isExplicitSkip: false,
    idempotencyKey: null,
    createSource: "WEB",
  });
  return { canonicalSlot: canonicalSlot!, row: applied.row };
}

describe("intake scheduledFor targeting — record the viewed dose", () => {
  it("a morning scheduledFor records the 07:00 slot, regardless of wall-clock", async () => {
    const medId = await createTwiceDailyMed();
    const slot0700 = localHmAsUtc(DAY, "Europe/Berlin", 7, 0);

    const { canonicalSlot, row } = await recordViaSchedule(medId, slot0700);

    expect(canonicalSlot.getTime()).toBe(slot0700.getTime());
    expect(row.scheduledFor.getTime()).toBe(slot0700.getTime());
    expect(row.takenAt).not.toBeNull();
  });

  it("an evening scheduledFor records the 19:00 slot, regardless of wall-clock", async () => {
    const medId = await createTwiceDailyMed();
    const slot1900 = localHmAsUtc(DAY, "Europe/Berlin", 19, 0);

    const { canonicalSlot, row } = await recordViaSchedule(medId, slot1900);

    expect(canonicalSlot.getTime()).toBe(slot1900.getTime());
    expect(row.scheduledFor.getTime()).toBe(slot1900.getTime());
    expect(row.takenAt).not.toBeNull();
  });

  it("marking the morning dose does not mark the evening dose (and vice-versa)", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();
    const slot0700 = localHmAsUtc(DAY, "Europe/Berlin", 7, 0);
    const slot1900 = localHmAsUtc(DAY, "Europe/Berlin", 19, 0);

    // Record ONLY the morning dose by supplying its slot instant.
    await recordViaSchedule(medId, slot0700);

    const morning = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0700,
        deletedAt: null,
      },
    });
    const evening = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot1900,
        deletedAt: null,
      },
    });

    // Exactly one taken morning row; the evening slot holds no taken row.
    expect(morning).toHaveLength(1);
    expect(morning[0]?.takenAt).not.toBeNull();
    expect(evening.filter((e) => e.takenAt !== null)).toHaveLength(0);

    // Now record the evening dose — the morning row stays as it was.
    await recordViaSchedule(medId, slot1900);

    const morningAfter = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0700,
        deletedAt: null,
      },
    });
    const eveningAfter = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot1900,
        deletedAt: null,
      },
    });
    expect(morningAfter).toHaveLength(1);
    expect(morningAfter[0]?.takenAt).not.toBeNull();
    expect(eveningAfter).toHaveLength(1);
    expect(eveningAfter[0]?.takenAt).not.toBeNull();
  });
});
