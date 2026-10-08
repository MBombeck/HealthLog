/**
 * #1031 — the nightly tombstone purge against a running restore.
 *
 * A restore clears every row of the account, tombstones included, inside one
 * long transaction that holds the account's restore lock exclusively. The
 * purge used to delete expired tombstones across accounts in one statement
 * per batch, without the lock: on an account under restore it waited on the
 * restore's row locks for as long as the restore ran, or deadlocked with it.
 *
 * Here a transaction stands in for the restore: it takes the lock, deletes the
 * account's rows, and holds for three seconds before rolling back. The purge
 * runs while it holds. What must hold: the purge does not wait, leaves the
 * account under restore alone and says so, and still purges every other
 * account.
 *
 * Mutation check: drop the `holdAccountAgainstRestore` call from
 * `purgeTombstonesByAccount` and the purge waits out the hold, then deletes
 * the restoring account's tombstones once the stand-in rolls back.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const RESTORING = "tombstone-restoring";
const OTHER = "tombstone-other";
const HOLD_MS = 3_000;
const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");

async function seed() {
  const prisma = getPrismaClient();
  for (const id of [RESTORING, OTHER]) {
    await prisma.user.create({
      data: { id, username: id, role: "USER", timezone: "UTC" },
    });
    for (let i = 0; i < 3; i++) {
      await prisma.measurement.create({
        data: {
          id: `${id}-tomb-${i}`,
          userId: id,
          type: "WEIGHT",
          value: 70 + i,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date(`2020-01-0${i + 1}T08:00:00.000Z`),
          deletedAt: LONG_AGO,
        },
      });
    }
    await prisma.moodEntry.create({
      data: {
        id: `${id}-mood-tomb`,
        userId: id,
        date: "2020-01-01",
        mood: "OKAY",
        score: 3,
        moodLoggedAt: new Date("2020-01-01T08:00:00.000Z"),
        deletedAt: LONG_AGO,
      },
    });
  }
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("tombstone purge against a running restore (#1031)", () => {
  it("leaves the account under restore for the next run without waiting on it", async () => {
    const prisma = getPrismaClient();
    await seed();
    const { takeRestoreLock } = await import("@/lib/export/restore-lock");
    const {
      cleanupExpiredMeasurementTombstones,
      cleanupExpiredMoodTombstones,
    } = await import("@/lib/jobs/measurement-tombstone-cleanup");

    let holding!: () => void;
    const isHolding = new Promise<void>((resolve) => (holding = resolve));
    const restore = prisma
      .$transaction(
        async (tx) => {
          await takeRestoreLock(tx, RESTORING);
          await tx.measurement.deleteMany({ where: { userId: RESTORING } });
          await tx.moodEntry.deleteMany({ where: { userId: RESTORING } });
          holding();
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
          throw new Error("rolled back");
        },
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    await isHolding;

    const started = Date.now();
    const measurements = await cleanupExpiredMeasurementTombstones(prisma);
    const moods = await cleanupExpiredMoodTombstones(prisma);
    const elapsed = Date.now() - started;
    await restore;

    expect(elapsed).toBeLessThan(HOLD_MS / 2);
    expect(measurements).toEqual({
      deleted: 3,
      drained: true,
      deferredAccounts: 1,
      deferredUserIds: [RESTORING],
    });
    expect(moods).toEqual({
      deleted: 1,
      drained: true,
      deferredAccounts: 1,
      deferredUserIds: [RESTORING],
    });
    // The stand-in rolled back, so the restoring account still has its
    // tombstones; the next run purges them.
    expect(
      await prisma.measurement.count({ where: { userId: RESTORING } }),
    ).toBe(3);
    expect(await prisma.measurement.count({ where: { userId: OTHER } })).toBe(
      0,
    );
    expect(await prisma.moodEntry.count({ where: { userId: OTHER } })).toBe(0);

    const next = await cleanupExpiredMeasurementTombstones(prisma);
    expect(next).toEqual({
      deleted: 3,
      drained: true,
      deferredAccounts: 0,
      deferredUserIds: [],
    });
  }, 60_000);

  it("a restore that starts during the purge waits only for the account's batch", async () => {
    const prisma = getPrismaClient();
    await seed();
    const { takeRestoreLock } = await import("@/lib/export/restore-lock");
    const { cleanupExpiredMeasurementTombstones } =
      await import("@/lib/jobs/measurement-tombstone-cleanup");

    const purge = cleanupExpiredMeasurementTombstones(prisma);
    const restore = prisma.$transaction(async (tx) => {
      await takeRestoreLock(tx, RESTORING);
      return tx.measurement.deleteMany({ where: { userId: RESTORING } });
    });
    const [purged] = await Promise.all([purge, restore]);

    // Whichever went first, both finished and nothing is left.
    expect(purged.deferredAccounts).toBeLessThanOrEqual(1);
    expect(await prisma.measurement.count({ where: { userId: OTHER } })).toBe(
      0,
    );
    expect(
      await prisma.measurement.count({ where: { userId: RESTORING } }),
    ).toBe(0);
  }, 60_000);
});
