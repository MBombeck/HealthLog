/**
 * Measurement-tombstone retention cleanup.
 *
 * Two guards:
 *   1. Behavioural: the helper hard-deletes only soft-deleted rows whose
 *      `deletedAt` predates the retention horizon, leaving live rows and
 *      recently-tombstoned rows untouched.
 *   2. Registry wiring: the queue is declared in the maintenance group,
 *      scheduled, and bound to its handler — a queue the registry does not
 *      declare is never created, and its schedule silently no-ops under
 *      pg-boss v12.
 */
import { describe, expect, it, vi } from "vitest";

import { cleanupExpiredMeasurementTombstones } from "../measurement-tombstone-cleanup";
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from "../purge-batch";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import { handleMeasurementTombstoneCleanup } from "../reminder/cleanup-handlers";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "../registry/__tests__/registry-helpers";

const DAY_MS = 86_400_000;

/**
 * A client whose interactive transaction hands the callback a client with the
 * same delegates, and whose restore-lock probe answers `held`.
 */
function mockClient(
  measurement: { findMany: unknown; deleteMany: unknown },
  held: (userId: string) => boolean = () => true,
) {
  const lockCalls: string[] = [];
  const tx = {
    measurement,
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => {
      const userId = key.replace(/^backup-restore:/, "");
      lockCalls.push(userId);
      return [{ held: held(userId) }];
    }),
  };
  const prisma = {
    measurement,
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as Parameters<typeof cleanupExpiredMeasurementTombstones>[0];
  return { prisma, lockCalls };
}

describe("cleanupExpiredMeasurementTombstones", () => {
  it("prunes only tombstones older than the retention horizon", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const findMany = vi.fn().mockResolvedValueOnce([
      { id: "a", userId: "u1" },
      { id: "b", userId: "u1" },
      { id: "c", userId: "u1" },
    ]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const { prisma } = mockClient({ findMany, deleteMany });

    const outcome = await cleanupExpiredMeasurementTombstones(prisma, now);
    expect(outcome).toEqual({
      deleted: 3,
      drained: true,
      deferredAccounts: 0,
      deferredUserIds: [],
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where as {
      deletedAt: { not: null; lt: Date };
    };
    // Only soft-deleted rows are eligible …
    expect(where.deletedAt.not).toBeNull();
    // … and only those past the horizon (retention days back from now).
    const expectedCutoff = new Date(
      now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS,
    );
    expect(where.deletedAt.lt.getTime()).toBe(expectedCutoff.getTime());

    // The delete is by primary key, so no single statement is on the hook for
    // the whole backlog.
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      id: { in: ["a", "b", "c"] },
    });
  });

  it("keeps walking a backlog that exceeds one batch, and reports when it stops short", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    // Always a full batch back — the predicate never exhausts, so the run has
    // to stop at the cap rather than loop forever.
    const fullBatch = Array.from({ length: PURGE_BATCH_SIZE }, (_, i) => ({
      id: `row-${i}`,
      userId: "u1",
    }));
    const findMany = vi.fn().mockResolvedValue(fullBatch);
    const deleteMany = vi.fn().mockResolvedValue({ count: PURGE_BATCH_SIZE });
    const { prisma } = mockClient({ findMany, deleteMany });

    const outcome = await cleanupExpiredMeasurementTombstones(prisma, now);

    expect(findMany).toHaveBeenCalledTimes(PURGE_MAX_BATCHES);
    expect(outcome.deleted).toBe(PURGE_BATCH_SIZE * PURGE_MAX_BATCHES);
    expect(outcome.drained).toBe(false);
    // Every lookup is bounded — an unbounded one is the shape that could not
    // finish inside statement_timeout.
    for (const call of findMany.mock.calls) {
      expect(call[0].take).toBe(PURGE_BATCH_SIZE);
    }
  });
});

describe("cleanupExpiredMeasurementTombstones — accounts under restore", () => {
  it("deletes one statement per account per batch, each under the account's restore lock", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([
      { id: "a1", userId: "a" },
      { id: "b1", userId: "b" },
      { id: "a2", userId: "a" },
    ]);
    const deleteMany = vi.fn(async ({ where }) => ({
      count: (where.id.in as string[]).length,
    }));
    const { prisma, lockCalls } = mockClient({ findMany, deleteMany });

    const outcome = await cleanupExpiredMeasurementTombstones(prisma);

    expect(outcome).toEqual({
      deleted: 3,
      drained: true,
      deferredAccounts: 0,
      deferredUserIds: [],
    });
    expect(lockCalls).toEqual(["a", "b"]);
    expect(deleteMany.mock.calls.map((call) => call[0].where)).toEqual([
      { id: { in: ["a1", "a2"] } },
      { id: { in: ["b1"] } },
    ]);
  });

  it("leaves an account under restore and keeps it out of the rest of the run", async () => {
    const full = (userId: string) =>
      Array.from({ length: PURGE_BATCH_SIZE }, (_, i) => ({
        id: `${userId}-${i}`,
        userId,
      }));
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(full("restoring"))
      .mockResolvedValueOnce([{ id: "other-1", userId: "other" }]);
    const deleteMany = vi.fn(async ({ where }) => ({
      count: (where.id.in as string[]).length,
    }));
    const { prisma } = mockClient(
      { findMany, deleteMany },
      (userId) => userId !== "restoring",
    );

    const outcome = await cleanupExpiredMeasurementTombstones(prisma);

    expect(outcome).toEqual({
      deleted: 1,
      drained: true,
      deferredAccounts: 1,
      deferredUserIds: ["restoring"],
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("userId");
    expect(findMany.mock.calls[1][0].where.userId).toEqual({
      notIn: ["restoring"],
    });
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});

describe("measurement-tombstone-cleanup schedule", () => {
  const QUEUE = "measurement-tombstone-cleanup";

  it("declares the queue at the documented Berlin cadence", () => {
    expect(jobOf(QUEUE).cron).toBe("40 3 * * *");
  });

  it("declares the queue in the maintenance group", () => {
    expect(groupOf(QUEUE).name).toBe("maintenance");
  });

  it("keeps the default retries on the schedule", () => {
    const job = jobOf(QUEUE);
    expect(job.scheduleOptions).toBeUndefined();
    expect(job.work).toEqual({ localConcurrency: 1 });
  });

  it("binds the cleanup handler to the queue", async () => {
    expect(await loadedHandler(QUEUE)).toBe(handleMeasurementTombstoneCleanup);
  });
});
