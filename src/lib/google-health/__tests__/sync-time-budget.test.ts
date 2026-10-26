/**
 * A caller's time limit (`shouldStop`, the hourly job's budget) reaches every
 * walk of the sync cycle, so a walk stops when it is spent; and a cycle that
 * stopped on it is not stamped, so the next run reads the rest from the same
 * watermark.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, recordSyncSuccess, resources } = vi.hoisted(() => {
  return {
    prismaMock: {
      integrationStatus: { findUnique: vi.fn(async () => null) },
      googleHealthConnection: {
        findUnique: vi.fn(async () => ({ lastSyncedAt: null })),
        update: vi.fn(async () => ({})),
      },
    },
    recordSyncSuccess: vi.fn(async () => {}),
    resources: {
      workout: vi.fn(async () => 0),
      sleep: vi.fn(async () => 0),
      activity: vi.fn(async () => 0),
      metrics: vi.fn(async () => 0),
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
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../sync-workout", () => ({ syncUserWorkout: resources.workout }));
vi.mock("../sync-sleep", () => ({ syncUserSleep: resources.sleep }));
vi.mock("../sync-activity", () => ({ syncUserActivity: resources.activity }));
vi.mock("../sync-metrics", () => ({ syncUserMetrics: resources.metrics }));

import { googleHealthSliceExhausted } from "@/lib/google-health/budget";
import { syncUserGoogleHealth } from "../sync";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
    lastSyncedAt: null,
  });
});

describe("the caller's time limit inside the sync cycle", () => {
  it("is what every resource's walks are asked, and an untouched one never stops", async () => {
    let spent = false;
    const asked: boolean[] = [];
    resources.metrics.mockImplementation(async () => {
      asked.push(googleHealthSliceExhausted());
      spent = true;
      asked.push(googleHealthSliceExhausted());
      return 0;
    });
    await syncUserGoogleHealth("budget-user", { shouldStop: () => spent });
    expect(asked).toEqual([false, true]);

    asked.length = 0;
    spent = false;
    await syncUserGoogleHealth("budget-user");
    expect(asked).toEqual([false, false]);
  });
});
