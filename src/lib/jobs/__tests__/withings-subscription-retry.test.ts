import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Job } from "pg-boss";

const retryDueWithingsWebhookSubscriptions = vi.hoisted(() =>
  vi.fn().mockResolvedValue(0),
);
const syncUserMeasurements = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ imported: 0, failed: false }),
);
const findMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const addWarning = vi.hoisted(() => vi.fn());
const isReauthRequired = vi.hoisted(() => vi.fn(async () => false));

vi.mock("@/lib/withings/sync", () => ({
  retryDueWithingsWebhookSubscriptions,
  syncUserMeasurements,
}));
vi.mock("@/lib/withings/sync-activity", () => ({
  syncUserActivity: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/withings/sync-sleep", () => ({
  syncUserSleep: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/withings/sync-ecg", () => ({
  syncUserEcg: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/jobs/reminder-satisfy", () => ({
  enqueueReminderSatisfy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/worker-status", () => ({
  recordError: vi.fn(),
  recordWithingsSync: vi.fn(),
}));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired,
}));
vi.mock("@/lib/logging/fire-and-forget", () => ({
  fireAndForget: vi.fn(),
}));
interface BackgroundEventMock {
  addWarning: Mock;
  setBackground: Mock;
  setError: Mock;
}

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    run: (event: BackgroundEventMock) => Promise<void>,
  ) =>
    run({
      addWarning,
      setBackground: vi.fn(),
      setError: vi.fn(),
    }),
}));
vi.mock("../reminder/shared", () => ({
  getWorkerPrisma: vi.fn(() => ({
    withingsConnection: { findMany },
  })),
}));

import {
  handleWithingsFallbackSync,
  type WithingsSyncPayload,
} from "../reminder/withings-sync";

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  retryDueWithingsWebhookSubscriptions.mockResolvedValue(0);
  syncUserMeasurements.mockResolvedValue({ imported: 0, failed: false });
  isReauthRequired.mockResolvedValue(false);
});

describe("handleWithingsFallbackSync subscription repair", () => {
  it("runs the due-subscription retry pass on the existing hourly worker", async () => {
    const queued = {
      data: { triggeredAt: "2026-07-21T10:00:00.000Z" },
    } as Job<WithingsSyncPayload>;

    await expect(handleWithingsFallbackSync([queued])).resolves.toEqual({
      ok: true,
      did: {
        provider: "withings",
        outcome: "clean_zero",
        total: 0,
        users_synced: 0,
        users_complete: 0,
        users_partial: 0,
        users_failed: 0,
        users_parked: 0,
        users_skipped: 0,
        users_useful: 0,
        users_clean_zero: 0,
        users_retryable: 0,
        downstream_failed: 0,
        measurements_imported: 0,
      },
    });

    expect(retryDueWithingsWebhookSubscriptions).toHaveBeenCalledTimes(1);
    expect(syncUserMeasurements).not.toHaveBeenCalled();
  });

  it("continues fallback polling for every connection when subscription repair rejects", async () => {
    const repairFailure = new Error("subscription state write failed");
    retryDueWithingsWebhookSubscriptions.mockRejectedValueOnce(repairFailure);
    findMany.mockResolvedValueOnce([
      { userId: "repair-failed-user" },
      { userId: "fallback-eligible-user" },
    ]);
    const queued = {
      data: { triggeredAt: "2026-07-21T11:00:00.000Z" },
    } as Job<WithingsSyncPayload>;

    // The repair is an auxiliary leg, not the pass this queue is named for:
    // the fallback sync still ran for everyone, so the job is done and the
    // repair failure rides out as a fact on the outcome.
    await expect(handleWithingsFallbackSync([queued])).resolves.toEqual({
      ok: true,
      did: {
        provider: "withings",
        outcome: "clean_zero",
        total: 2,
        users_synced: 2,
        users_complete: 2,
        users_partial: 0,
        users_failed: 0,
        users_parked: 0,
        users_skipped: 0,
        users_useful: 0,
        users_clean_zero: 2,
        users_retryable: 0,
        downstream_failed: 1,
        measurements_imported: 0,
      },
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { user: { deletionRequestedAt: null } },
      select: { userId: true },
    });
    expect(syncUserMeasurements).toHaveBeenNthCalledWith(
      1,
      "repair-failed-user",
    );
    expect(syncUserMeasurements).toHaveBeenNthCalledWith(
      2,
      "fallback-eligible-user",
    );
    expect(addWarning).toHaveBeenCalledWith(
      "Withings subscription repair failed; continuing fallback sync",
    );
  });
});
