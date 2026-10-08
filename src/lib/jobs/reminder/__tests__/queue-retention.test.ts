/**
 * v1.42 — shortened pg-boss retention for the pure volume queues.
 *
 * A failed job stays readable in `pgboss.job` only until
 * `completed_on + deletion_seconds`, and the admin status reads failures from
 * there over a 72-hour window (`job-failures.ts`). A volume queue kept for
 * less than that window plus a day would let its failures vanish before they
 * were shown, so the floor is pinned here, the list stays the four queues
 * that were decided on, and the registrar applies the value on create and on
 * every boot.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { $executeRaw: vi.fn().mockResolvedValue(0) },
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

import { JOB_FAILURE_WINDOW_HOURS } from "@/lib/jobs/job-failures";
import {
  QUEUE_RETENTION_FLOOR_SECONDS,
  VOLUME_QUEUE_DELETE_AFTER_SECONDS,
  createAndSchedule,
} from "../registrar-shared";

describe("volume queue retention", () => {
  it("never drops below the failure window plus a day", () => {
    expect(QUEUE_RETENTION_FLOOR_SECONDS).toBeGreaterThanOrEqual(
      (JOB_FAILURE_WINDOW_HOURS + 24) * 3600,
    );
    for (const [queue, seconds] of Object.entries(
      VOLUME_QUEUE_DELETE_AFTER_SECONDS,
    )) {
      expect(seconds, queue).toBeGreaterThanOrEqual(
        QUEUE_RETENTION_FLOOR_SECONDS,
      );
    }
  });

  it("covers exactly the four volume queues", () => {
    expect(Object.keys(VOLUME_QUEUE_DELETE_AFTER_SECONDS).sort()).toEqual([
      "__pgboss__send-it",
      "host-metric-sample",
      "insight-status-generate",
      "rollup-recompute",
    ]);
  });

  it("creates a volume queue with its retention and updates it on an existing instance", async () => {
    const boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      updateQueue: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
    };
    await createAndSchedule(
      boss as never,
      ["host-metric-sample", "some-other-queue"],
      [["host-metric-sample", "*/5 * * * *"]],
    );
    expect(boss.createQueue).toHaveBeenCalledWith("host-metric-sample", {
      deleteAfterSeconds: QUEUE_RETENTION_FLOOR_SECONDS,
    });
    expect(boss.createQueue).toHaveBeenCalledWith("some-other-queue", {});
    expect(boss.updateQueue).toHaveBeenCalledWith("host-metric-sample", {
      deleteAfterSeconds: QUEUE_RETENTION_FLOOR_SECONDS,
    });
    // The timekeeper's queue rides along whenever the registrar schedules.
    expect(boss.updateQueue).toHaveBeenCalledWith("__pgboss__send-it", {
      deleteAfterSeconds: QUEUE_RETENTION_FLOOR_SECONDS,
    });
    expect(boss.updateQueue).not.toHaveBeenCalledWith(
      "some-other-queue",
      expect.anything(),
    );
  });

  it("does not fail the boot when an update is refused", async () => {
    const boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      updateQueue: vi.fn().mockRejectedValue(new Error("nope")),
      schedule: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      createAndSchedule(boss as never, ["rollup-recompute"], []),
    ).resolves.toBeUndefined();
  });
});
