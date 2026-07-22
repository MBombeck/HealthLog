/**
 * Pins the verdict gate of `runGoogleHealthBackfillForUser`: the
 * `backfillCompletedAt` marker may only be stamped after a CLEAN full-history
 * run. `syncUserGoogleHealth` swallows per-resource errors into its verdict —
 * before the gate, ANY run (partial hard failure, parked no-op) stamped the
 * marker and the pg-boss `retryLimit: 3` was dead code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, syncUserGoogleHealthMock, isReauthRequiredMock } =
  vi.hoisted(() => ({
    prismaMock: {
      googleHealthConnection: { findMany: vi.fn(), update: vi.fn() },
    },
    syncUserGoogleHealthMock: vi.fn(),
    isReauthRequiredMock: vi.fn(async () => false),
  }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: vi.fn() }),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: isReauthRequiredMock,
}));

vi.mock("@/lib/google-health/sync-core", () => ({
  GOOGLE_HEALTH_INTEGRATION_KEY: "google-health",
}));
vi.mock("@/lib/google-health/sync", () => ({
  syncUserGoogleHealth: (...a: unknown[]) => syncUserGoogleHealthMock(...a),
}));

import { runGoogleHealthBackfillForUser } from "../google-health-backfill";

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequiredMock.mockResolvedValue(false);
  prismaMock.googleHealthConnection.update.mockResolvedValue({});
});

describe("runGoogleHealthBackfillForUser — verdict-gated marker", () => {
  it("stamps backfillCompletedAt after a CLEAN full-history run", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 42, failed: false });

    const { imported } = await runGoogleHealthBackfillForUser("u1");

    expect(imported).toBe(42);
    expect(syncUserGoogleHealthMock).toHaveBeenCalledWith("u1", {
      fullSync: true,
    });
    const updateArg = prismaMock.googleHealthConnection.update.mock
      .calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.backfillCompletedAt).toBeInstanceOf(Date);
  });

  it("a failed verdict THROWS without stamping — pg-boss retries become real", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 7, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isReauthRequiredMock.mockResolvedValue(true);

    await expect(runGoogleHealthBackfillForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserGoogleHealthMock).not.toHaveBeenCalled();
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });
});
