/**
 * RED contract for GH-02/SYNC-01.
 *
 * Antonios's trace proves only that 786 Heart Rate pages preceded Exercise.
 * It does not prove a provider defect or a safe universal page limit. This
 * fixture therefore models all 786 successful pages and requires the
 * inexpensive workout resource to reach a terminal before dense metrics
 * pagination begins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { calls, prismaMock, recordSyncSuccess, resources } = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    prismaMock: {
      integrationStatus: { findUnique: vi.fn(async () => null) },
      googleHealthConnection: {
        findUnique: vi.fn(async () => ({ lastSyncedAt: null })),
        update: vi.fn(async () => ({})),
      },
    },
    recordSyncSuccess: vi.fn(async () => {}),
    resources: {
      workout: vi.fn(async () => {
        calls.push("workout:complete");
        return 1;
      }),
      sleep: vi.fn(async () => {
        calls.push("sleep:complete");
        return 0;
      }),
      activity: vi.fn(async () => {
        calls.push("activity:complete");
        return 0;
      }),
      metrics: vi.fn(async () => {
        for (let page = 1; page <= 786; page++) {
          calls.push(`heart-rate:${page}`);
        }
        calls.push("heart-rate:complete");
        return 786;
      }),
    },
  };
});

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

// The account lock is a Postgres advisory lock on a connection of its own;
// these cases run without a database, so the lock is always free.
vi.mock("../sync-lock", () => ({
  withGoogleHealthSyncLock: async (
    _userId: string,
    run: () => Promise<unknown>,
  ) => ({
    ran: true,
    result: await run(),
  }),
}));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncSuccess,
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../sync-workout", () => ({ syncUserWorkout: resources.workout }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: resources.sleep }));
vi.mock("../sync-activity", () => ({ syncUserActivity: resources.activity }));
vi.mock("../sync-metrics", () => ({ syncUserMetrics: resources.metrics }));

import { syncUserGoogleHealth } from "../sync";

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
    lastSyncedAt: null,
  });
});

describe("Google Health workout-first fairness", () => {
  it("finishes workout before the first of 786 successful heart-rate pages", async () => {
    const result = await syncUserGoogleHealth("fair-user", { fullSync: true });

    expect(calls.indexOf("workout:complete")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("workout:complete")).toBeLessThan(
      calls.indexOf("heart-rate:1"),
    );
    expect(
      calls.filter((entry) => entry.startsWith("heart-rate:")),
    ).toHaveLength(787);
    expect(result).toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({
          resource: "workout",
          status: "complete",
          written: 1,
        }),
      ]),
    });
  });
});
