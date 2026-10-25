/**
 * The end of a provider's full-history backfill marks the read caches stale.
 *
 * The per-write tail always did (through `afterMeasurementMutation`), but the
 * backfill tail refolded the rollups and re-warmed the status cards without
 * touching the analytics caches, so the dashboard and the analytics reads went
 * on serving the pre-backfill body until its TTL ran out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: (keys: Array<{ type: string; measuredAt: Date }>) =>
    keys,
  recomputeUserRollups: vi.fn(async () => undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMeasurements: vi.fn(),
  invalidateUserDashboardSnapshot: vi.fn(),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => undefined),
}));
vi.mock("@/lib/rollups/after-measurement-mutation", () => ({
  afterMeasurementMutation: vi.fn(),
}));
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(async () => undefined),
}));

import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

import { afterProviderBackfill } from "../after-write";

const keys = [
  { type: "WEIGHT" as const, measuredAt: new Date("2026-03-05T00:00:00Z") },
  { type: "PULSE" as const, measuredAt: new Date("2026-01-10T00:00:00Z") },
  { type: "WEIGHT" as const, measuredAt: new Date("2026-02-01T00:00:00Z") },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("afterProviderBackfill", () => {
  it("marks the user's read caches stale back to the first touched day", async () => {
    await afterProviderBackfill({ userId: "u1", provider: "fitbit", keys });

    expect(recomputeUserRollups).toHaveBeenCalledWith("u1", {
      types: ["WEIGHT", "PULSE"],
      from: new Date("2026-01-10T00:00:00Z"),
      to: new Date("2026-03-06T00:00:00Z"),
    });
    expect(invalidateUserMeasurements).toHaveBeenCalledTimes(1);
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("u1", {
      touchedFrom: new Date("2026-01-10T00:00:00Z"),
    });
    // After the fold, so a reader rebuilds against the new rollups.
    expect(
      vi.mocked(invalidateUserMeasurements).mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      vi.mocked(recomputeUserRollups).mock.invocationCallOrder[0]!,
    );
    expect(invalidateStatusInsightsForTypes).toHaveBeenCalledWith(
      "u1",
      ["WEIGHT", "PULSE"],
      { source: "sync" },
    );
  });

  it("marks them stale even when the fold fails, and still throws for the caller", async () => {
    vi.mocked(recomputeUserRollups).mockRejectedValueOnce(new Error("fold"));

    await expect(
      afterProviderBackfill({ userId: "u1", provider: "fitbit", keys }),
    ).rejects.toThrow("fold");
    expect(invalidateUserMeasurements).toHaveBeenCalledWith("u1", {
      touchedFrom: new Date("2026-01-10T00:00:00Z"),
    });
  });

  it("does nothing for a backfill that touched nothing", async () => {
    await afterProviderBackfill({ userId: "u1", provider: "fitbit", keys: [] });
    expect(recomputeUserRollups).not.toHaveBeenCalled();
    expect(invalidateUserMeasurements).not.toHaveBeenCalled();
  });
});
