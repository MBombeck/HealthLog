/**
 * `afterMeasurementMutation` — the shared post-mutation tail every
 * measurement write surface calls (rollup recompute + status-insight
 * invalidation).
 *
 * Watched red: with the recompute loop removed from the helper the
 * first test fails naming the missing `recomputeBucketsForKeys`
 * call; with the `.catch` isolation removed the failure-isolation test
 * throws. Both verified red against a deliberately broken helper before
 * the real implementation landed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recompute: vi.fn(),
  invalidate: vi.fn(),
}));

// The helper pulls `collapseToTypeDayKeys` (pure) from the rollup
// module; keep the original for it so the collapse behaviour under
// test is the real one, and stub only the impure recompute. `@/lib/db`
// is stubbed so importing the original module never touches Prisma.
vi.mock("@/lib/db", () => ({ prisma: {} }));

vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-rollups")>();
  return {
    ...actual,
    recomputeBucketsForKeys: async (
      userId: string,
      keys: Array<{ type: string; measuredAt: Date }>,
    ) => {
      for (const k of keys) await mocks.recompute(userId, k.type, k.measuredAt);
    },
  };
});

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: mocks.invalidate,
}));

import { afterMeasurementMutation } from "../after-measurement-mutation";
import { annotate, eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import type { MeasurementType } from "@/generated/prisma/client";

beforeEach(() => {
  mocks.recompute.mockReset().mockResolvedValue(undefined);
  mocks.invalidate.mockReset().mockResolvedValue(undefined);
});

const day = (iso: string) => new Date(iso);

describe("afterMeasurementMutation", () => {
  it("recomputes one bucket per distinct (type, day) and invalidates each type once", async () => {
    await afterMeasurementMutation(
      "user-1",
      [
        {
          type: "WEIGHT" as MeasurementType,
          measuredAt: day("2026-05-10T08:00:00Z"),
        },
        {
          type: "WEIGHT" as MeasurementType,
          measuredAt: day("2026-05-10T21:00:00Z"),
        },
        {
          type: "PULSE" as MeasurementType,
          measuredAt: day("2026-05-10T09:00:00Z"),
        },
      ],
      { source: "sync" },
    );

    // Two rows on the same (WEIGHT, day) collapse into one recompute.
    expect(mocks.recompute).toHaveBeenCalledTimes(2);
    expect(mocks.recompute).toHaveBeenCalledWith(
      "user-1",
      "WEIGHT",
      day("2026-05-10T00:00:00Z"),
    );
    expect(mocks.recompute).toHaveBeenCalledWith(
      "user-1",
      "PULSE",
      day("2026-05-10T00:00:00Z"),
    );

    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    const [userId, types, options] = mocks.invalidate.mock.calls[0];
    expect(userId).toBe("user-1");
    expect([...types].sort()).toEqual(["PULSE", "WEIGHT"]);
    // The caller's source reaches the invalidator, which picks the gap by it.
    expect(options).toEqual({ source: "sync" });
  });

  it("is a no-op for an empty row set", async () => {
    await expect(
      afterMeasurementMutation("user-1", [], { source: "manual" }),
    ).resolves.toEqual({ rollupFailed: false });
    expect(mocks.recompute).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("still invalidates status insights when the rollup recompute fails", async () => {
    mocks.recompute.mockRejectedValue(new Error("populator down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result: { rollupFailed: boolean } | undefined;
    try {
      result = await afterMeasurementMutation(
        "user-1",
        [
          {
            type: "WEIGHT" as MeasurementType,
            measuredAt: day("2026-05-10T08:00:00Z"),
          },
        ],
        { source: "manual", label: "test.surface" },
      );
    } finally {
      warn.mockRestore();
    }
    // The rollup failure never bubbles AND never gates the second leg; the
    // caller learns of it from the result.
    expect(result).toEqual({ rollupFailed: true });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
  });

  it("leaves the status cards alone when the caller invalidates them itself", async () => {
    await expect(
      afterMeasurementMutation(
        "user-1",
        [
          {
            type: "WEIGHT" as MeasurementType,
            measuredAt: day("2026-05-10T08:00:00Z"),
          },
        ],
        { source: "sync", invalidateStatus: false },
      ),
    ).resolves.toEqual({ rollupFailed: false });
    expect(mocks.recompute).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("never rejects when the status-insight invalidation fails", async () => {
    mocks.invalidate.mockRejectedValue(new Error("cache down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        afterMeasurementMutation(
          "user-1",
          [
            {
              type: "WEIGHT" as MeasurementType,
              measuredAt: day("2026-05-10T08:00:00Z"),
            },
          ],
          { source: "manual" },
        ),
      ).resolves.toEqual({ rollupFailed: false });
      // Let the fire-and-forget rejection settle inside the helper's catch.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the request's action name while the detached re-warm annotates its own", async () => {
    // The re-warm is detached from the request but starts inside its
    // context. It annotates an action of its own when it skips; that must
    // never rename the write the request is reporting.
    mocks.invalidate.mockImplementation(async () => {
      annotate({
        action: { name: "insights.status.invalidate.skipped" },
        meta: { reason: "no_provider" },
      });
    });
    const event = new WideEventBuilder();
    await eventStorage.run(event, async () => {
      annotate({ action: { name: "measurement.create" } });
      await afterMeasurementMutation(
        "user-1",
        [
          {
            type: "WEIGHT" as MeasurementType,
            measuredAt: day("2026-05-10T08:00:00Z"),
          },
        ],
        { source: "manual" },
      );
      await settleBackgroundTasks();
    });
    expect(mocks.invalidate).toHaveBeenCalledTimes(1);
    expect(event.toJSON().action?.name).toBe("measurement.create");
    // What the detached work says still reaches the request's event.
    expect(event.toJSON().meta?.reason).toBe("no_provider");
  });
});
