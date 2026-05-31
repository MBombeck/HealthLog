/**
 * v1.7.0 — measurement-tombstone retention cleanup.
 *
 * Two guards:
 *   1. Behavioural: the helper hard-deletes only soft-deleted rows whose
 *      `deletedAt` predates the retention horizon, leaving live rows and
 *      recently-tombstoned rows untouched.
 *   2. Source-grep wiring (same approach as the drain-cumulative guard):
 *      the queue is registered in `allQueues`, scheduled, and bound to a
 *      `boss.work` handler — a missing `allQueues` entry silently no-ops
 *      the schedule under pg-boss v12.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { cleanupExpiredMeasurementTombstones } from "../measurement-tombstone-cleanup";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";

const DAY_MS = 86_400_000;

describe("cleanupExpiredMeasurementTombstones", () => {
  it("prunes only tombstones older than the retention horizon", async () => {
    const now = new Date("2026-06-01T00:00:00.000Z");
    const deleteMany = vi
      .fn()
      .mockResolvedValue({ count: 3 });
    const prisma = {
      measurement: { deleteMany },
    } as unknown as Parameters<typeof cleanupExpiredMeasurementTombstones>[0];

    const pruned = await cleanupExpiredMeasurementTombstones(prisma, now);
    expect(pruned).toBe(3);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where as {
      deletedAt: { not: null; lt: Date };
    };
    // Only soft-deleted rows are eligible …
    expect(where.deletedAt.not).toBeNull();
    // … and only those past the horizon (retention days back from now).
    const expectedCutoff = new Date(
      now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS,
    );
    expect(where.deletedAt.lt.getTime()).toBe(expectedCutoff.getTime());
  });
});

describe("reminder-worker — measurement-tombstone-cleanup schedule", () => {
  const source = readFileSync(
    join(__dirname, "..", "reminder-worker.ts"),
    "utf8",
  );

  it("declares the queue at the documented Berlin cadence", () => {
    expect(source).toMatch(
      /MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE\s*=\s*["']measurement-tombstone-cleanup["']/,
    );
    expect(source).toMatch(
      /MEASUREMENT_TOMBSTONE_CLEANUP_CRON\s*=\s*["']40 3 \* \* \*["']/,
    );
  });

  it("registers the queue in the allQueues createQueue loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(
      /\bMEASUREMENT_TOMBSTONE_CLEANUP_QUEUE\b/,
    );
  });

  it("schedules the cron via boss.schedule (allQueues + schedules)", () => {
    expect(source).toMatch(
      /\[MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE,\s*MEASUREMENT_TOMBSTONE_CLEANUP_CRON\]/,
    );
  });

  it("binds a boss.work handler to the queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE[\s\S]{0,200}handleMeasurementTombstoneCleanup/,
    );
  });
});
