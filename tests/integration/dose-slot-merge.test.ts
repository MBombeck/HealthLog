/**
 * One live dose row per slot, for rows written before the rule existed.
 *
 * Migration 0515 made the live slot unique without `source`, so a slot that a
 * pill box (ingest, `API`) and a Telegram button (`REMINDER`) both answered
 * held two live rows until then. Two places have to make such rows fit the
 * index, with the same rule (`slot-merge.ts`): the migration, for the rows
 * in the database, and the restore, for every backup written before it. A
 * merged take also took stock off a pack a second time; both give it back.
 *
 * Mutations that must turn these red: drop the merge in
 * `restoreIntakeEvents` (the restore fails on the unique index), drop the
 * `restoreForIntake` call there or the `refund` CTE in the migration (the
 * pack stays one short), or invert the rank in `slot-merge.ts` (the skip
 * stays live instead of the take).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { encrypt } from "@/lib/crypto";
import { STORED_BACKUP_SELECT } from "@/lib/export/stored-backup";
import { restoreBackup } from "@/lib/export/restore-backup";

import { getPrismaClient, truncateAllTables } from "./setup";

const MIGRATION_0515 = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "0515_dose_state_integrity",
    "migration.sql",
  ),
  "utf8",
);

/**
 * 0515 also creates `live_activity_tokens_device_id_idx`, which 0538 drops.
 * Replaying 0515 brings it back, so the case runs 0538 after it to hand the
 * next file in the worker the head schema (`schema-fingerprint.ts`).
 */
const MIGRATION_0538 = readFileSync(
  path.join(
    process.cwd(),
    "prisma",
    "migrations",
    "0538_drop_redundant_live_activity_device_index",
    "migration.sql",
  ),
  "utf8",
);

const SLOT = "2026-11-02T07:00:00.000Z";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seedOwner(username: string) {
  return getPrismaClient().user.create({
    data: { username, email: `${username}@example.test`, timezone: "UTC" },
  });
}

async function storeBackup(userId: string, payload: unknown) {
  const prisma = getPrismaClient();
  const row = await prisma.dataBackup.create({
    data: {
      userId,
      type: "MANUAL_UPLOAD_SLOT_MERGE_TEST",
      data: encrypt(JSON.stringify(payload)),
    },
  });
  return prisma.dataBackup.findUniqueOrThrow({
    where: { id: row.id },
    select: STORED_BACKUP_SELECT,
  });
}

async function restore(userId: string, payload: unknown) {
  return restoreBackup({
    backup: await storeBackup(userId, payload),
    actorUserId: userId,
    ipAddress: null,
    restoreInstanceSettings: false,
  });
}

function payloadFor(userId: string, extra: Record<string, unknown>) {
  return {
    schemaVersion: "1",
    exportedAt: "2026-11-03T10:00:00.000Z",
    userId,
    measurements: [],
    medications: [],
    intakeEvents: [],
    moodEntries: [],
    ...extra,
  };
}

describe("restore of a backup written before 0515", () => {
  it("merges two live takes of one slot and refunds the second pack decrement", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("slot-merge-dr");
    const medId = "med_slot_merge_dr";
    const itemId = "pack_slot_merge_dr";
    const payload = payloadFor(owner.id, {
      medications: [
        {
          id: medId,
          name: "Example",
          dose: "5 mg",
          inventoryItems: [
            {
              id: itemId,
              state: "IN_USE",
              containerType: "BLISTER",
              unitsTotal: "10",
              unitsRemaining: "8",
              firstUseAt: "2026-11-01T07:00:00.000Z",
            },
          ],
        },
      ],
      intakeEvents: [
        {
          id: "intake_reminder",
          medicationId: medId,
          medication: "Example",
          scheduledFor: SLOT,
          takenAt: "2026-11-02T07:05:00.000Z",
          skipped: false,
          source: "REMINDER",
          createdAt: "2026-11-02T06:00:00.000Z",
          syncVersion: 2,
          inventoryConsumption: [{ itemId, units: 1 }],
        },
        {
          id: "intake_pillbox",
          medicationId: medId,
          medication: "Example",
          scheduledFor: SLOT,
          takenAt: "2026-11-02T07:06:00.000Z",
          skipped: false,
          source: "API",
          createdAt: "2026-11-02T07:06:00.000Z",
          syncVersion: 0,
          inventoryConsumption: [{ itemId, units: 1 }],
        },
      ],
    });

    const outcome = await restore(owner.id, payload);
    expect(outcome.ok).toBe(true);

    const rows = await prisma.medicationIntakeEvent.findMany({
      where: { userId: owner.id },
      orderBy: { id: "asc" },
    });
    expect(rows).toHaveLength(2);
    const live = rows.filter((r) => r.deletedAt === null);
    expect(live.map((r) => r.id)).toEqual(["intake_reminder"]);
    const merged = rows.find((r) => r.id === "intake_pillbox")!;
    expect(merged.deletedAt).not.toBeNull();
    expect(merged.syncVersion).toBe(1);
    expect(merged.inventoryConsumption).toBeNull();
    // The kept take keeps its own stamp; only the merged one is refunded.
    expect(live[0].inventoryConsumption).toEqual([{ itemId, units: 1 }]);

    const pack = await prisma.medicationInventoryItem.findUniqueOrThrow({
      where: { id: itemId },
    });
    expect(Number(pack.unitsRemaining)).toBe(9);
  });

  it("keeps the take over a skip in a portable file, whatever the order", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("slot-merge-portable");
    const payload = payloadFor(owner.id, {
      medications: [{ ref: "src_med", name: "Example", dose: "5 mg" }],
      intakeEvents: [
        {
          ref: "src_skip",
          medicationRef: "src_med",
          medication: "Example",
          scheduledFor: SLOT,
          takenAt: null,
          skipped: true,
          source: "REMINDER",
        },
        {
          ref: "src_take",
          medicationRef: "src_med",
          medication: "Example",
          scheduledFor: SLOT,
          takenAt: "2026-11-02T07:06:00.000Z",
          skipped: false,
          source: "API",
        },
        // A pending row of a different slot is not touched.
        {
          ref: "src_other",
          medicationRef: "src_med",
          medication: "Example",
          scheduledFor: "2026-11-02T19:00:00.000Z",
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        },
      ],
    });

    const outcome = await restore(owner.id, payload);
    expect(outcome.ok).toBe(true);

    const live = await prisma.medicationIntakeEvent.findMany({
      where: { userId: owner.id, deletedAt: null },
      orderBy: { scheduledFor: "asc" },
    });
    expect(live).toHaveLength(2);
    expect(live[0].takenAt?.toISOString()).toBe("2026-11-02T07:06:00.000Z");
    expect(live[0].skipped).toBe(false);
    expect(live[1].scheduledFor.toISOString()).toBe("2026-11-02T19:00:00.000Z");
    const tombstones = await prisma.medicationIntakeEvent.findMany({
      where: { userId: owner.id, deletedAt: { not: null } },
    });
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].skipped).toBe(true);
  });

  it("leaves a file tombstone out of the merge", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("slot-merge-tombstone");
    const medId = "med_slot_merge_tomb";
    const payload = payloadFor(owner.id, {
      medications: [{ id: medId, name: "Example", dose: "5 mg" }],
      intakeEvents: [
        {
          id: "intake_deleted",
          medicationId: medId,
          medication: "Example",
          scheduledFor: SLOT,
          takenAt: "2026-11-02T07:01:00.000Z",
          source: "WEB",
          createdAt: "2026-11-02T07:01:00.000Z",
          deletedAt: "2026-11-02T07:02:00.000Z",
          syncVersion: 3,
        },
        {
          id: "intake_live",
          medicationId: medId,
          medication: "Example",
          scheduledFor: SLOT,
          takenAt: null,
          skipped: true,
          source: "WEB",
          createdAt: "2026-11-02T07:03:00.000Z",
          syncVersion: 1,
        },
      ],
    });
    const outcome = await restore(owner.id, payload);
    expect(outcome.ok).toBe(true);
    const live = await prisma.medicationIntakeEvent.findMany({
      where: { userId: owner.id, deletedAt: null },
    });
    expect(live.map((r) => [r.id, r.syncVersion])).toEqual([
      ["intake_live", 1],
    ]);
    const tomb = await prisma.medicationIntakeEvent.findUniqueOrThrow({
      where: { id: "intake_deleted" },
    });
    expect(tomb.syncVersion).toBe(3);
  });
});

describe("migration 0515 on a database that still holds duplicates", () => {
  it("merges by the slot rule and refunds the merged take's stock", async () => {
    const prisma = getPrismaClient();
    const owner = await seedOwner("slot-merge-migration");
    const med = await prisma.medication.create({
      data: { userId: owner.id, name: "Example", dose: "5 mg" },
    });
    const pack = await prisma.medicationInventoryItem.create({
      data: {
        userId: owner.id,
        medicationId: med.id,
        state: "USED_UP",
        containerType: "BLISTER",
        unitsTotal: 10,
        unitsRemaining: 0,
        firstUseAt: new Date("2026-10-01T07:00:00.000Z"),
      },
    });
    const stamp = [{ itemId: pack.id, units: 1 }];

    // The index as it was before 0515: the slot was unique per source.
    await prisma.$executeRawUnsafe(
      `DROP INDEX IF EXISTS "medication_intake_events_user_med_slot_live_key"`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "medication_intake_events_user_med_slot_source_live_key"
           ON "medication_intake_events" ("user_id", "medication_id", "scheduled_for", "source")
           WHERE "deleted_at" IS NULL`,
      );
      const older = await prisma.medicationIntakeEvent.create({
        data: {
          userId: owner.id,
          medicationId: med.id,
          scheduledFor: new Date(SLOT),
          takenAt: new Date("2026-11-02T07:05:00.000Z"),
          source: "REMINDER",
          createdAt: new Date("2026-11-02T06:00:00.000Z"),
          inventoryConsumption: stamp,
        },
      });
      const newer = await prisma.medicationIntakeEvent.create({
        data: {
          userId: owner.id,
          medicationId: med.id,
          scheduledFor: new Date(SLOT),
          takenAt: new Date("2026-11-02T07:06:00.000Z"),
          source: "API",
          createdAt: new Date("2026-11-02T07:06:00.000Z"),
          inventoryConsumption: stamp,
        },
      });

      await prisma.$executeRawUnsafe(MIGRATION_0515);

      const after = await prisma.medicationIntakeEvent.findMany({
        where: { medicationId: med.id },
      });
      const kept = after.find((r) => r.id === older.id)!;
      const merged = after.find((r) => r.id === newer.id)!;
      expect(kept.deletedAt).toBeNull();
      expect(kept.inventoryConsumption).toEqual(stamp);
      expect(merged.deletedAt).not.toBeNull();
      expect(merged.inventoryConsumption).toBeNull();
      expect(merged.syncVersion).toBe(1);

      const refunded = await prisma.medicationInventoryItem.findUniqueOrThrow({
        where: { id: pack.id },
      });
      expect(Number(refunded.unitsRemaining)).toBe(1);
      expect(refunded.state).toBe("IN_USE");

      // A second run finds nothing left to merge or refund.
      await prisma.$executeRawUnsafe(MIGRATION_0515);
      const again = await prisma.medicationInventoryItem.findUniqueOrThrow({
        where: { id: pack.id },
      });
      expect(Number(again.unitsRemaining)).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP INDEX IF EXISTS "medication_intake_events_user_med_slot_source_live_key"`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX IF NOT EXISTS "medication_intake_events_user_med_slot_live_key"
           ON "medication_intake_events" ("user_id", "medication_id", "scheduled_for")
           WHERE "deleted_at" IS NULL`,
      );
      await prisma.$executeRawUnsafe(MIGRATION_0538);
    }
  });
});
