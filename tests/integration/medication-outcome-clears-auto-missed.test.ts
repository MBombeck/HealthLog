/**
 * A recorded outcome is never an auto-miss.
 *
 * The auto-miss pass stamps `autoMissed` on a dose nobody answered. A late
 * take or a deliberate skip recorded afterwards must clear it on every write
 * path, or the cadence timeline, the streak and the achievements keep reading
 * the dose as missed while the ledger and the today list read it as taken.
 * Migration 0515 holds the invariant in the database; the route cases prove
 * the readers agree, the raw-write case proves the trigger.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { localHmAsUtc } from "@/lib/tz/local-day";
import {
  DAY_MS,
  TZ,
  perMedPost,
  readCadence,
  setupDoseFixture,
  statusPost,
} from "./medication-dose-state-fixtures";

vi.mock("next/headers", async () =>
  (await import("./medication-dose-state-fixtures")).nextHeadersMock(),
);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function autoMissedRowTwoDaysAgo() {
  const prisma = getPrismaClient();
  const fixture = await setupDoseFixture({ offsetHours: 12 });
  const slot = localHmAsUtc(
    new Date(Date.now() - 2 * DAY_MS),
    TZ,
    fixture.hour,
    0,
  );
  const row = await prisma.medicationIntakeEvent.create({
    data: {
      userId: fixture.user.id,
      medicationId: fixture.medId,
      scheduledFor: slot,
      takenAt: null,
      skipped: false,
      source: "REMINDER",
      autoMissed: true,
    },
  });
  return { ...fixture, slot, row };
}

async function liveRows(medicationId: string) {
  return getPrismaClient().medicationIntakeEvent.findMany({
    where: { medicationId, deletedAt: null },
  });
}

describe("a recorded outcome clears the auto-miss stamp", () => {
  for (const status of ["taken", "skipped"] as const) {
    it(`status route ${status}: the row and the cadence timeline agree`, async () => {
      const { medId, slot, row } = await autoMissedRowTwoDaysAgo();
      const r = await statusPost(
        status === "taken"
          ? {
              intakeId: row.id,
              status,
              takenAt: new Date(slot.getTime() + 10 * 60_000).toISOString(),
            }
          : { intakeId: row.id, status },
      );
      expect(r.status).toBe(200);
      const after = await liveRows(medId);
      expect(after.every((x) => x.autoMissed === false)).toBe(true);
      const cell = (await readCadence(medId)).timeline.find(
        (x) => new Date(x.windowStart).getTime() === slot.getTime(),
      );
      expect(cell?.status).toBe(status);
    });
  }

  it("a skip through the per-medication route clears it", async () => {
    const { medId, slot } = await autoMissedRowTwoDaysAgo();
    const r = await perMedPost(medId, {
      skipped: true,
      scheduledFor: slot.toISOString(),
    });
    expect(r.status).toBeLessThan(300);
    const after = await liveRows(medId);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => x.autoMissed === false)).toBe(true);
  });

  it("holds for a write that names no flag at all", async () => {
    const { row } = await autoMissedRowTwoDaysAgo();
    const prisma = getPrismaClient();
    const updated = await prisma.medicationIntakeEvent.update({
      where: { id: row.id },
      data: { takenAt: new Date() },
    });
    expect(updated.autoMissed).toBe(false);
    const created = await prisma.medicationIntakeEvent.create({
      data: {
        userId: row.userId,
        medicationId: row.medicationId,
        scheduledFor: new Date(row.scheduledFor.getTime() - DAY_MS),
        skipped: true,
        autoMissed: true,
        source: "WEB",
      },
    });
    expect(created.autoMissed).toBe(false);
  });
});
