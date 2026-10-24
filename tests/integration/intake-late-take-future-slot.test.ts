/**
 * Regression: a late-morning take must not consume the evening slot.
 *
 * The medication card threads the DISPLAYED dose's slot onto the intake POST
 * as `scheduledFor`. Once a morning slot's catch-up window has lapsed the card
 * advances its display-due to the EVENING slot, so a "Genommen" tap for the
 * (missed) morning dose posts `scheduledFor = 21:00` with `takenAt = now`
 * (13:08). Band attribution correctly refuses the take (it lands in no
 * window), but the route's source-agnostic convergence probe used to bind it
 * to the 21:00 pending REMINDER row — recording the morning dose as the
 * evening one, silently consuming a slot the user had not reached, and jumping
 * the dashboard "next intake" to tomorrow.
 *
 * These tests drive the SAME shipped helpers the per-medication intake route
 * runs for a taken write (`resolveSlotForWriteByBand` → the
 * `mayConvergeOntoSuppliedSlot` guard → the convergence probe /
 * `applyCanonicalSlotWrite` / standalone insert) against real Postgres for a
 * twice-daily 09:00 / 21:00 medication, then assert the read model the
 * dashboard composes (`computeDisplayDue` + the taken/scheduled tally) reflects
 * the correct state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  applyCanonicalSlotWrite,
  mayConvergeOntoSuppliedSlot,
  resolveSlotForWriteByBand,
} from "@/lib/medications/scheduling/slot-upsert";
import {
  computeDisplayDue,
  toResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TEST_USER_ID = "user-late-take-future-slot";
const TZ = "Europe/Berlin";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Fixed non-DST-boundary weekday so the slot instants are deterministic.
const DAY = new Date("2026-03-10T12:00:00.000Z");
const slot0900 = () => localHmAsUtc(DAY, TZ, 9, 0);
const slot2100 = () => localHmAsUtc(DAY, TZ, 21, 0);
/** The real recording moment: 13:08, i.e. 8 minutes past the 09:00 slot's
 *  +4h catch-up cutoff (09:00 on-time ±1h → 10:00, overdue tail → 13:00). */
const takenAt1308 = () => localHmAsUtc(DAY, TZ, 13, 8);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "late-take-future-slot",
      email: "late-take-future-slot@example.test",
      timezone: TZ,
    },
  });
});

async function createTwiceDailyMed(): Promise<string> {
  const prisma = getPrismaClient();
  const med = await prisma.medication.create({
    data: {
      userId: TEST_USER_ID,
      name: "Ramipril",
      dose: "5mg",
      active: true,
      startsOn: new Date("2026-01-01T00:00:00.000Z"),
      schedules: {
        create: {
          windowStart: "09:00",
          windowEnd: "21:00",
          timesOfDay: ["09:00", "21:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return med.id;
}

/** Mint the day's two pending REMINDER rows exactly as the projector would. */
async function projectPendingSlots(medId: string): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.medicationIntakeEvent.createMany({
    data: [
      {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0900(),
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
      {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot2100(),
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    ],
  });
}

/**
 * Replicate the per-medication intake route's taken-write branch for a card
 * "Genommen" tap: band attribution on `takenAt`, then the ad-hoc fallback
 * (the `mayConvergeOntoSuppliedSlot` guard gating the convergence probe, else
 * a standalone insert). Uses the real shipped helpers so the guard under test
 * is the one shipped in the route.
 */
async function recordViaCard(
  prisma: PrismaClient,
  medId: string,
  suppliedSlot: Date,
  takenAt: Date,
): Promise<void> {
  const attribution = await resolveSlotForWriteByBand({
    userId: TEST_USER_ID,
    medicationId: medId,
    userTz: TZ,
    takenAt,
    now: takenAt,
  });
  const canonicalSlot = attribution.slotInstant;

  if (canonicalSlot) {
    await applyCanonicalSlotWrite({
      client: prisma,
      userId: TEST_USER_ID,
      medicationId: medId,
      canonicalSlot,
      takenAt,
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
      attributionSource: "AUTO",
    });
    return;
  }

  const existingSlotRow = mayConvergeOntoSuppliedSlot({
    skipped: false,
    takenAt,
    suppliedSlot,
  })
    ? await prisma.medicationIntakeEvent.findFirst({
        where: {
          userId: TEST_USER_ID,
          medicationId: medId,
          scheduledFor: suppliedSlot,
          deletedAt: null,
        },
        select: { id: true },
      })
    : null;

  if (existingSlotRow) {
    await applyCanonicalSlotWrite({
      client: prisma,
      userId: TEST_USER_ID,
      medicationId: medId,
      canonicalSlot: suppliedSlot,
      takenAt,
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
      attributionSource: "AUTO",
    });
  } else {
    // Genuinely standalone (ad-hoc): anchor on the intake instant.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: takenAt,
        takenAt,
        skipped: false,
        source: "WEB",
      },
    });
  }
}

async function readDisplayDue(medId: string, now: Date): Promise<Date | null> {
  const prisma = getPrismaClient();
  const med = await prisma.medication.findUniqueOrThrow({
    where: { id: medId },
    include: { schedules: true },
  });
  // Mirror `buildMedsTodayBlock`: resolved slots = taken / skipped / autoMissed
  // rows, each carrying its anchoring shape.
  const resolvedEvents = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId: TEST_USER_ID,
      medicationId: medId,
      deletedAt: null,
      OR: [{ takenAt: { not: null } }, { skipped: true }, { autoMissed: true }],
    },
    select: { scheduledFor: true, takenAt: true },
  });
  const display = computeDisplayDue({
    medication: {
      id: med.id,
      startsOn: med.startsOn,
      endsOn: med.endsOn,
      endedAt: null,
      oneShot: med.oneShot,
      createdAt: med.createdAt,
    },
    schedules: med.schedules,
    now,
    userTz: TZ,
    lastIntakeAt: null,
    resolvedSlots: resolvedEvents.map(toResolvedSlotMark),
  });
  return display?.at ?? null;
}

describe("late-morning take does not consume the evening slot", () => {
  it("records the 13:08 take standalone; the 21:00 slot stays pending", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();
    await projectPendingSlots(medId);

    // Card shows 21:00 (09:00 catch-up lapsed); the tap posts scheduledFor=21:00.
    await recordViaCard(prisma, medId, slot2100(), takenAt1308());

    const eveningRow = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot2100(),
        deletedAt: null,
      },
    });
    // The evening slot must NOT have been consumed by the morning take.
    expect(eveningRow.takenAt).toBeNull();
    expect(eveningRow.skipped).toBe(false);

    // Exactly one taken row, anchored ad-hoc on its own 13:08 instant.
    const takenRows = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        deletedAt: null,
        takenAt: { not: null },
      },
    });
    expect(takenRows).toHaveLength(1);
    expect(takenRows[0]!.takenAt!.getTime()).toBe(takenAt1308().getTime());
    // Ad-hoc contract: scheduledFor === takenAt (not a slot anchor).
    expect(takenRows[0]!.scheduledFor.getTime()).toBe(takenAt1308().getTime());

    // The morning slot stays open too (nothing filled it).
    const morningRow = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0900(),
        deletedAt: null,
      },
    });
    expect(morningRow.takenAt).toBeNull();
  });

  it("next intake stays 21:00 today — it does not jump to tomorrow", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();
    await projectPendingSlots(medId);

    await recordViaCard(prisma, medId, slot2100(), takenAt1308());

    const due = await readDisplayDue(medId, takenAt1308());
    expect(due).not.toBeNull();
    // The still-open evening slot today, NOT tomorrow's 09:00.
    expect(due!.getTime()).toBe(slot2100().getTime());
  });

  it("the pre-fix convergence would have consumed 21:00 and jumped to tomorrow (mechanism)", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();
    await projectPendingSlots(medId);

    // Reproduce the OLD behaviour explicitly: converge the 13:08 take onto the
    // 21:00 pending row (what the ungated probe did).
    await applyCanonicalSlotWrite({
      client: prisma,
      userId: TEST_USER_ID,
      medicationId: medId,
      canonicalSlot: slot2100(),
      takenAt: takenAt1308(),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
      attributionSource: "AUTO",
    });

    const eveningRow = await prisma.medicationIntakeEvent.findFirstOrThrow({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot2100(),
        deletedAt: null,
      },
    });
    // Confirms the bug shape: the evening slot carries the morning take.
    expect(eveningRow.takenAt!.getTime()).toBe(takenAt1308().getTime());

    // And the dashboard next-due jumps past today to tomorrow's 09:00.
    const due = await readDisplayDue(medId, takenAt1308());
    expect(due).not.toBeNull();
    expect(due!.getTime()).toBeGreaterThan(slot2100().getTime());
    const tomorrow0900 = localHmAsUtc(
      new Date(DAY.getTime() + 24 * 60 * 60 * 1000),
      TZ,
      9,
      0,
    );
    expect(due!.getTime()).toBe(tomorrow0900.getTime());
  });
});
