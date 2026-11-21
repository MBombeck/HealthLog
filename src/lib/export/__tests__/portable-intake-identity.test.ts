/**
 * A portable intake row names its medication by the source id, not only by
 * name: medication names are not unique on an account, and a restore that
 * resolved by name put every dose of two same-named drugs on the first. It
 * also names its own source id, which a seizure rescue dose points at.
 */
import { describe, expect, it } from "vitest";

import { iterateBackupIntakeEvents } from "@/lib/export/medications-backup";

const SLOT = new Date("2026-11-20T07:00:00.000Z");

function event(id: string, medicationId: string) {
  return {
    id,
    medicationId,
    medication: { name: "Ibuprofen" },
    scheduledFor: SLOT,
    takenAt: SLOT,
    skipped: false,
    source: "WEB",
    autoRecorded: false,
    autoMissed: false,
    attributionSource: "AUTO",
    idempotencyKey: null,
    createdAt: SLOT,
    updatedAt: SLOT,
    injectionSite: null,
    doseTaken: null,
    inventoryConsumption: null,
    externalId: null,
    syncVersion: 0,
    deletedAt: null,
  };
}

describe("portable intake events of two same-named medications", () => {
  it("carry the medication's and their own source ids", async () => {
    const prisma = {
      medicationIntakeEvent: {
        findMany: async () => [event("e1", "med-A"), event("e2", "med-B")],
      },
    };
    const rows: Record<string, unknown>[] = [];
    for await (const row of iterateBackupIntakeEvents(
      prisma as never,
      "user-1",
      false,
    )) {
      rows.push(row);
    }
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toEqual(rows[1]);
    expect(rows.map((r) => [r.ref, r.medicationRef])).toEqual([
      ["e1", "med-A"],
      ["e2", "med-B"],
    ]);
    // No restored ids: a portable restore mints fresh ones.
    expect(rows.every((r) => r.id === undefined)).toBe(true);
    expect(rows.every((r) => r.medicationId === undefined)).toBe(true);
  });

  it("the disaster-recovery row carries the ids themselves", async () => {
    const prisma = {
      medicationIntakeEvent: {
        findMany: async () => [event("e1", "med-A"), event("e2", "med-B")],
      },
    };
    const rows: Record<string, unknown>[] = [];
    for await (const row of iterateBackupIntakeEvents(
      prisma as never,
      "user-1",
      true,
    )) {
      rows.push(row);
    }
    expect(rows.map((r) => r.medicationId)).toEqual(["med-A", "med-B"]);
    expect(rows.every((r) => r.medicationRef === undefined)).toBe(true);
  });
});
