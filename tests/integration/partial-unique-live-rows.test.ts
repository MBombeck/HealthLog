/**
 * v1.12.1 — partial live-row unique index on MedicationIntakeEvent
 * (migration 0121).
 *
 * This pins the delete-then-resync contract on real Postgres, against the
 * migrations replayed by `global-setup.ts`: the real re-take path through
 * `applyCanonicalSlotWrite` takes a slot, soft-deletes it (user "forgot
 * this"), then re-takes the SAME canonical slot. Pre-0121 the create P2002'd
 * against the tombstone and the catch re-found only live rows (none) and
 * re-threw — the re-take 500'd. With the partial live-row unique it re-creates
 * cleanly.
 *
 * The MoodEntry half of this file drove migration 0122's external-id dedup key
 * through the moodLog webhook. That bridge was retired in v1.32.33; the same
 * index is pinned end-to-end through the surviving native write paths in
 * `mood-entries-external-id.test.ts`.
 *
 * Note: Measurement is intentionally NOT made partial-unique (its
 * compound-key writes use `prisma.upsert` → native ON CONFLICT, which
 * Postgres cannot arbiter against a partial unique). See migration 0121's
 * header for the full rationale.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { applyCanonicalSlotWrite } from "@/lib/medications/scheduling/slot-upsert";

import { getPrismaClient, truncateAllTables } from "./setup";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("MedicationIntakeEvent — re-take after delete (v1.12.1 / 0121)", () => {
  it("re-takes a previously-deleted slot without 500-ing", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "partial-intake",
        email: "partial-intake@example.test",
        role: "USER",
      },
    });
    const med = await prisma.medication.create({
      data: { userId: user.id, name: "Ramipril", dose: "5mg" },
    });

    const slot = new Date("2026-06-03T06:00:00.000Z");

    // First take — fresh slot.
    const firstTake = await applyCanonicalSlotWrite({
      client: prisma,
      userId: user.id,
      medicationId: med.id,
      canonicalSlot: slot,
      takenAt: new Date("2026-06-03T06:05:00.000Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
    });
    expect(firstTake.outcome).toBe("inserted");
    expect(firstTake.row.takenAt).not.toBeNull();

    // User deletes the take (soft-delete the slot row).
    await prisma.medicationIntakeEvent.update({
      where: { id: firstTake.row.id },
      data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
    });

    // Re-take the SAME canonical slot. Pre-0121 this threw the original
    // P2002 (tombstone occupied (user, med, scheduled_for, source)).
    const reTake = await applyCanonicalSlotWrite({
      client: prisma,
      userId: user.id,
      medicationId: med.id,
      canonicalSlot: slot,
      takenAt: new Date("2026-06-03T06:10:00.000Z"),
      skipped: false,
      isExplicitTaken: true,
      isExplicitSkip: false,
      idempotencyKey: null,
      createSource: "WEB",
    });
    expect(reTake.outcome).toBe("inserted");
    expect(reTake.row.id).not.toBe(firstTake.row.id);
    expect(reTake.row.takenAt).not.toBeNull();

    // Exactly one LIVE slot row; the tombstone remains.
    const live = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        medicationId: med.id,
        scheduledFor: slot,
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(reTake.row.id);

    // The live-row partial unique still forbids a SECOND live duplicate
    // on the same (user, med, slot, source).
    await expect(
      prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: med.id,
          scheduledFor: slot,
          source: "WEB",
        },
      }),
    ).rejects.toThrow();
  });
});
