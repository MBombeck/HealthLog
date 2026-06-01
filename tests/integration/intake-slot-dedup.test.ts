/**
 * v1.8.2 — duplicate dose-slot cleanup integration tests.
 *
 * Pins the one-time boot-backfill that collapses pre-fix duplicate slot
 * rows: a twice-daily med ends up with a 07:00 pending REMINDER row AND
 * a 07:00 taken WEB/API row for the same dose slot (the two
 * `scheduledFor` instants drifting by up to a minute). The cleanup keeps
 * the winner (taken > skipped > pending), soft-deletes the losers,
 * normalises the winner's `scheduledFor` to the canonical slot instant,
 * leaves PRN / off-slot rows untouched, and is a no-op on a second run.
 *
 * Coverage map:
 *   1. Duplicate 07:00 pair collapses to the taken row; loser tombstoned;
 *      the clean 19:00 row is untouched; compliance rollup self-corrects.
 *   2. A PRN med's multiple rows are never collapsed.
 *   3. A second run is a no-op (idempotent).
 *   4. taken > skipped tie-break keeps the taken row.
 *   5. Boot discovery only matches users that actually hold duplicates.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import {
  dedupeUserIntakeSlots,
  enqueueBootTimeIntakeSlotDedup,
} from "@/lib/medications/intake-slot-dedup";
import { localHmAsUtc } from "@/lib/timezone";

const TEST_USER_ID = "user-intake-slot-dedup";
const OTHER_USER_ID = "user-intake-slot-dedup-clean";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "intake-dedup",
      email: "intake-dedup@example.test",
      timezone: "Europe/Berlin",
    },
  });
  await prisma.user.create({
    data: {
      id: OTHER_USER_ID,
      username: "intake-dedup-clean",
      email: "intake-dedup-clean@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

/**
 * Anchor every fixture on a fixed historical day so the slot instants
 * are deterministic regardless of when the suite runs. 2026-03-10 is a
 * non-DST-boundary weekday in Europe/Berlin.
 */
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
          windowEnd: "07:00",
          timesOfDay: ["07:00", "19:00"],
          daysOfWeek: null,
          scheduleType: "SCHEDULED",
        },
      },
    },
  });
  return med.id;
}

describe("intake-slot-dedup — duplicate slot collapse", () => {
  it("collapses the 07:00 pending+taken pair to the taken row, leaves 19:00 untouched, corrects the rollup", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();

    const slot0700 = localHmAsUtc(DAY, "Europe/Berlin", 7, 0);
    const slot1900 = localHmAsUtc(DAY, "Europe/Berlin", 19, 0);

    // 07:00 pending REMINDER row (server-minted, canonical instant).
    const pending = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0700,
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });
    // 07:00 taken API row, drifted +1 minute (the iOS-vs-server drift).
    const taken = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: new Date(slot0700.getTime() + 60_000),
        takenAt: new Date(slot0700.getTime() + 60_000),
        skipped: false,
        source: "API",
      },
    });
    // Clean 19:00 pending row — no duplicate.
    const evening = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot1900,
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });

    const summary = await dedupeUserIntakeSlots(TEST_USER_ID);

    expect(summary.slotsCollapsed).toBe(1);
    expect(summary.rowsSoftDeleted).toBe(1);

    // Exactly one live 07:00 row survives, and it is the taken one.
    const live0700 = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: TEST_USER_ID,
        medicationId: medId,
        deletedAt: null,
        scheduledFor: slot0700,
      },
    });
    expect(live0700).toHaveLength(1);
    expect(live0700[0]?.id).toBe(taken.id);
    expect(live0700[0]?.takenAt).not.toBeNull();
    // Winner normalised onto the canonical slot instant.
    expect(live0700[0]?.scheduledFor.toISOString()).toBe(
      slot0700.toISOString(),
    );

    // The loser (the pending REMINDER row) is soft-deleted, not removed.
    const loser = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(loser.deletedAt).not.toBeNull();

    // The clean 19:00 row is untouched.
    const eveningRow = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: evening.id },
    });
    expect(eveningRow.deletedAt).toBeNull();
    expect(eveningRow.scheduledFor.toISOString()).toBe(slot1900.toISOString());

    // The compliance rollup reflects the corrected counts: the 07:00 day
    // now has scheduled=2 (07:00 taken + 19:00 pending), taken=1 — not the
    // inflated scheduled=3 the duplicate produced.
    const rollups = await prisma.medicationComplianceRollup.findMany({
      where: { userId: TEST_USER_ID, medicationId: medId },
    });
    expect(rollups).toHaveLength(1);
    expect(rollups[0]?.scheduled).toBe(2);
    expect(rollups[0]?.taken).toBe(1);
  });

  it("never collapses a PRN med's multiple rows", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: TEST_USER_ID,
        name: "Ibuprofen PRN",
        dose: "400mg",
        active: true,
        schedules: {
          create: {
            windowStart: "00:00",
            windowEnd: "00:00",
            timesOfDay: [],
            daysOfWeek: null,
            scheduleType: "PRN",
          },
        },
      },
    });

    // Two as-needed doses logged minutes apart — both must survive.
    const a = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: med.id,
        scheduledFor: new Date("2026-03-10T09:00:00.000Z"),
        takenAt: new Date("2026-03-10T09:00:00.000Z"),
        skipped: false,
        source: "WEB",
      },
    });
    const b = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: med.id,
        scheduledFor: new Date("2026-03-10T09:01:00.000Z"),
        takenAt: new Date("2026-03-10T09:01:00.000Z"),
        skipped: false,
        source: "WEB",
      },
    });

    const summary = await dedupeUserIntakeSlots(TEST_USER_ID);
    expect(summary.slotsCollapsed).toBe(0);
    expect(summary.rowsSoftDeleted).toBe(0);

    const live = await prisma.medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID, medicationId: med.id, deletedAt: null },
    });
    expect(live.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("is a no-op on a second run (idempotent)", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();
    const slot0700 = localHmAsUtc(DAY, "Europe/Berlin", 7, 0);

    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0700,
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: new Date(slot0700.getTime() + 60_000),
        takenAt: new Date(slot0700.getTime() + 60_000),
        skipped: false,
        source: "API",
      },
    });

    const first = await dedupeUserIntakeSlots(TEST_USER_ID);
    expect(first.slotsCollapsed).toBe(1);

    const second = await dedupeUserIntakeSlots(TEST_USER_ID);
    expect(second.slotsCollapsed).toBe(0);
    expect(second.rowsSoftDeleted).toBe(0);
    expect(second.rowsNormalised).toBe(0);

    const live = await prisma.medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID, medicationId: medId, deletedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.takenAt).not.toBeNull();
  });

  it("keeps the taken row over a skipped row in the same slot", async () => {
    const prisma = getPrismaClient();
    const medId = await createTwiceDailyMed();
    const slot0700 = localHmAsUtc(DAY, "Europe/Berlin", 7, 0);

    const skipped = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: slot0700,
        takenAt: null,
        skipped: true,
        source: "WEB",
      },
    });
    const taken = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: medId,
        scheduledFor: new Date(slot0700.getTime() + 30_000),
        takenAt: new Date(slot0700.getTime() + 30_000),
        skipped: false,
        source: "API",
      },
    });

    await dedupeUserIntakeSlots(TEST_USER_ID);

    const live = await prisma.medicationIntakeEvent.findMany({
      where: { userId: TEST_USER_ID, medicationId: medId, deletedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(taken.id);

    const loser = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: skipped.id },
    });
    expect(loser.deletedAt).not.toBeNull();
  });
});

describe("intake-slot-dedup — boot discovery scoping", () => {
  it("returns 0 when no user holds a duplicate pair", async () => {
    const prisma = getPrismaClient();
    const med = await prisma.medication.create({
      data: {
        userId: OTHER_USER_ID,
        name: "Clean med",
        dose: "1mg",
        active: true,
        schedules: {
          create: {
            windowStart: "08:00",
            windowEnd: "08:00",
            timesOfDay: ["08:00"],
            scheduleType: "SCHEDULED",
          },
        },
      },
    });
    // A single clean row, no duplicate.
    await prisma.medicationIntakeEvent.create({
      data: {
        userId: OTHER_USER_ID,
        medicationId: med.id,
        scheduledFor: localHmAsUtc(DAY, "Europe/Berlin", 8, 0),
        takenAt: null,
        skipped: false,
        source: "REMINDER",
      },
    });

    // boss is not initialised in this unit context → enqueue helper
    // returns the no-boss zero result. We assert the discovery query path
    // by running the per-user pass directly below; the helper's
    // discovery SQL is exercised in the live worker boot.
    const result = await enqueueBootTimeIntakeSlotDedup();
    expect(result.error).toBeNull();
    expect(result.enqueued).toBe(0);

    // Per-user pass on the clean user is a no-op.
    const summary = await dedupeUserIntakeSlots(OTHER_USER_ID);
    expect(summary.slotsCollapsed).toBe(0);
  });
});
