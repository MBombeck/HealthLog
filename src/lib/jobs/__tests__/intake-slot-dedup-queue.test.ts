/**
 * Duplicate dose-slot dedup queue registration guard.
 *
 * Reads the worker registry: the queue is declared in the maintenance group
 * with its daily cron, bound to the dedup handler, and offered again by the
 * maintenance boot discovery. The bound handler runs against a mocked dedup
 * module, so pg-boss and Prisma never boot. An unregistered queue silently
 * never drains (the past incident this guard exists to prevent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dedupeUserIntakeSlots, enqueueBootTimeIntakeSlotDedup } = vi.hoisted(
  () => ({
    dedupeUserIntakeSlots: vi.fn(async () => ({
      slotsCollapsed: 0,
      rowsSoftDeleted: 0,
      rowsNormalised: 0,
      daysRecomputed: 0,
    })),
    enqueueBootTimeIntakeSlotDedup: vi.fn(async () => ({
      enqueued: 0,
      skipped: 0,
      error: null,
    })),
  }),
);
vi.mock("@/lib/medications/intake-slot-dedup", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/medications/intake-slot-dedup")
  >()),
  dedupeUserIntakeSlots,
  enqueueBootTimeIntakeSlotDedup,
}));

import type { Job } from "pg-boss";

import { handleIntakeSlotDedup } from "@/lib/jobs/reminder/maintenance-handlers";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import {
  INTAKE_SLOT_DEDUP_CONCURRENCY,
  INTAKE_SLOT_DEDUP_QUEUE,
} from "@/lib/medications/intake-slot-dedup";

function job(data: { userId?: string }): Job<{ userId?: string }> {
  return {
    id: "j1",
    name: INTAKE_SLOT_DEDUP_QUEUE,
    data,
    expireInSeconds: 60,
    heartbeatSeconds: null,
    retryCount: 0,
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("intake-slot-dedup registration", () => {
  it("declares the intake-slot-dedup queue in the maintenance group", () => {
    expect(groupOf(INTAKE_SLOT_DEDUP_QUEUE).name).toBe("maintenance");
    const definition = jobOf(INTAKE_SLOT_DEDUP_QUEUE);
    expect(definition.policy?.policy).toBe("exclusive");
    expect(definition.work).toEqual({
      localConcurrency: INTAKE_SLOT_DEDUP_CONCURRENCY,
    });
  });

  it("binds the dedup handler, which runs the per-user dedup", async () => {
    expect(await loadedHandler(INTAKE_SLOT_DEDUP_QUEUE)).toBe(
      handleIntakeSlotDedup,
    );
    await handleIntakeSlotDedup([job({ userId: "u1" })]);
    expect(dedupeUserIntakeSlots).toHaveBeenCalledWith("u1");
    expect(enqueueBootTimeIntakeSlotDedup).not.toHaveBeenCalled();
  });

  it("fires the boot-discovery pass", () => {
    expect(discoveryOf("maintenance")).toContain("intake-slot-dedup");
  });

  // The boot-only pass left duplicates created between deploys standing
  // until the next worker restart. The queue also carries a daily cron tick
  // whose empty payload (no `userId`) dispatches the same discovery fan-out.
  it("declares a daily cron inside the 03:xx maintenance window", () => {
    // Five-field cron, daily (day-of-month/month/day-of-week all `*`),
    // inside the 03:xx maintenance window.
    expect(jobOf(INTAKE_SLOT_DEDUP_QUEUE).cron).toMatch(/^\d{1,2} 3 \* \* \*$/);
  });

  it("dispatches a payload without userId to the discovery fan-out", async () => {
    await handleIntakeSlotDedup([job({})]);
    expect(enqueueBootTimeIntakeSlotDedup).toHaveBeenCalledTimes(1);
    expect(dedupeUserIntakeSlots).not.toHaveBeenCalled();
  });
});
