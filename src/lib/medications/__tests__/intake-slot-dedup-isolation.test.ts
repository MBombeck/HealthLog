/**
 * v1.8.2 reconcile (cleanup-job MEDIUM) — per-slot error isolation.
 *
 * The winner-`scheduledFor` normalise can throw P2002 (a tombstoned row
 * already sits on the canonical instant with the winner's source — the
 * unique index does not filter `deleted_at`). Before the fix, one such
 * collision dead-lettered the whole user's job (pg-boss retries re-throw),
 * so the user's OTHER duplicate slots never collapsed. This proves the
 * per-slot try/catch + P2002 guard keeps the loop going.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));

import { dedupeUserIntakeSlots } from "../intake-slot-dedup";
import { prisma } from "@/lib/db";
import { recomputeMedicationComplianceForEvent } from "@/lib/rollups/medication-compliance-rollups";

const TZ = "Europe/Berlin";

// A daily 07:00 / 19:00 SCHEDULED med. The slot resolver snaps the seeded
// rows onto the two canonical instants.
const SCHEDULE = {
  id: "s1",
  windowStart: "07:00",
  windowEnd: "07:00",
  daysOfWeek: null,
  timesOfDay: ["07:00", "19:00"],
  reminderGraceMinutes: null,
  rrule: null,
  rollingIntervalDays: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
};

const MED = {
  id: "med-1",
  userId: "u1",
  startsOn: null,
  endsOn: null,
  oneShot: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  schedules: [SCHEDULE],
};

// Two duplicate rows per slot (07:00 and 19:00) on 2026-06-15 CEST.
// 07:00 CEST = 05:00Z, 19:00 CEST = 17:00Z. Each slot has a pending
// REMINDER row + a taken WEB row a minute apart → both collapse, both
// need a winner normalise.
function seedRows() {
  return [
    {
      id: "r-07-rem",
      medicationId: "med-1",
      scheduledFor: new Date("2026-06-15T05:00:00.000Z"),
      takenAt: null,
      skipped: false,
      syncVersion: 0,
      createdAt: new Date("2026-06-15T00:00:00Z"),
    },
    {
      id: "r-07-web",
      medicationId: "med-1",
      scheduledFor: new Date("2026-06-15T05:01:00.000Z"),
      takenAt: new Date("2026-06-15T05:01:00.000Z"),
      skipped: false,
      syncVersion: 1,
      createdAt: new Date("2026-06-15T05:01:00Z"),
    },
    {
      id: "r-19-rem",
      medicationId: "med-1",
      scheduledFor: new Date("2026-06-15T17:00:00.000Z"),
      takenAt: null,
      skipped: false,
      syncVersion: 0,
      createdAt: new Date("2026-06-15T00:00:00Z"),
    },
    {
      id: "r-19-web",
      medicationId: "med-1",
      scheduledFor: new Date("2026-06-15T17:01:00.000Z"),
      takenAt: new Date("2026-06-15T17:01:00.000Z"),
      skipped: false,
      syncVersion: 1,
      createdAt: new Date("2026-06-15T17:01:00Z"),
    },
  ];
}

function p2002(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timezone: TZ,
  } as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([MED] as never);
  // First findFirst = lastIntake probe (rolling anchor) → none.
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    seedRows() as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.updateMany).mockResolvedValue({
    count: 1,
  } as never);
});

describe("dedupeUserIntakeSlots — per-slot error isolation", () => {
  it("continues other slots when one slot's normalise throws P2002", async () => {
    // The FIRST winner normalise (07:00 slot) throws P2002; the second
    // (19:00 slot) succeeds. Both losers still soft-delete; the job must
    // NOT throw, and the 19:00 slot must still collapse + recompute.
    vi.mocked(prisma.medicationIntakeEvent.update)
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({} as never);

    const summary = await dedupeUserIntakeSlots("u1");

    // Job did not throw; both slots were processed (collapsed).
    expect(summary.slotsCollapsed).toBe(2);
    // Both slots' losers soft-deleted (updateMany once per slot).
    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(2);
    // The 07:00 normalise was swallowed (P2002), the 19:00 normalise
    // succeeded → exactly one normalised row counted.
    expect(summary.rowsNormalised).toBe(1);
    // Both canonical days recomputed despite the collision.
    expect(recomputeMedicationComplianceForEvent).toHaveBeenCalledTimes(2);
  });

  it("isolates a non-P2002 error per slot without dead-lettering the job", async () => {
    // A genuine unexpected error inside the slot bubbles past the inner
    // P2002 guard but is caught by the OUTER per-slot isolation
    // (annotate + continue), so the job still completes without throwing.
    // The failing slot is not counted as collapsed (the throw happens
    // before the collapse counter), but the loop moves on.
    vi.mocked(prisma.medicationIntakeEvent.update).mockRejectedValue(
      new Error("connection reset"),
    );
    const summary = await dedupeUserIntakeSlots("u1");
    // Both slots threw on normalise → neither reached the collapse
    // counter, but the job completed (no throw) — the isolation worked.
    expect(summary.slotsCollapsed).toBe(0);
    expect(summary.rowsNormalised).toBe(0);
    // Losers were still soft-deleted before the normalise throw.
    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(2);
  });
});
