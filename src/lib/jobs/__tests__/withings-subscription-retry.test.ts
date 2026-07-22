import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Job } from "pg-boss";

const retryDueWithingsWebhookSubscriptions = vi.hoisted(() =>
  vi.fn().mockResolvedValue(0),
);
const syncUserMeasurements = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const findMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const addWarning = vi.hoisted(() => vi.fn());

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
  syncUserMeasurements.mockResolvedValue(0);
});

describe("handleWithingsFallbackSync subscription repair", () => {
  it("runs the due-subscription retry pass on the existing hourly worker", async () => {
    const queued = {
      data: { triggeredAt: "2026-07-21T10:00:00.000Z" },
    } as Job<WithingsSyncPayload>;

    await handleWithingsFallbackSync([queued]);

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

    await expect(handleWithingsFallbackSync([queued])).resolves.toBeUndefined();

    expect(findMany).toHaveBeenCalledWith({ select: { userId: true } });
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
