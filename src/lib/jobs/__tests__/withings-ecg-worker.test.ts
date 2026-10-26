import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";
const { syncUserEcg } = vi.hoisted(() => ({
  syncUserEcg:
    vi.fn<
      (
        userId: string,
        options?: { startdate?: number; enddate?: number },
      ) => Promise<number>
    >(),
}));
const isReauthRequired = vi.hoisted(() => vi.fn(async () => false));

vi.mock("@/lib/withings/sync-ecg", () => ({
  syncUserEcg: (
    userId: string,
    options?: { startdate?: number; enddate?: number },
  ) => syncUserEcg(userId, options),
}));
vi.mock("@/lib/withings/sync", () => ({
  syncUserMeasurements: vi.fn(async () => 0),
}));
vi.mock("@/lib/withings/sync-activity", () => ({
  syncUserActivity: vi.fn(async () => 0),
}));
vi.mock("@/lib/withings/sync-sleep", () => ({
  syncUserSleep: vi.fn(async () => 0),
}));
vi.mock("@/lib/jobs/reminder-satisfy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/reminder-satisfy")>()),
  enqueueReminderSatisfy: vi.fn(async () => undefined),
}));
vi.mock("@/lib/jobs/worker-status", () => ({
  recordError: vi.fn(),
  recordWithingsSync: vi.fn(),
}));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired,
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (event: {
      setBackground: (value: unknown) => void;
      setError: (error: unknown) => void;
      addWarning: (warning: string) => void;
    }) => Promise<void>,
  ) =>
    fn({
      setBackground: vi.fn(),
      setError: vi.fn(),
      addWarning: vi.fn(),
    }),
}));
vi.mock("@/lib/logging/fire-and-forget", () => ({
  fireAndForget: vi.fn(),
}));
const { ecgFindMany } = vi.hoisted(() => ({
  ecgFindMany: vi.fn<(...a: unknown[]) => Promise<Array<{ userId: string }>>>(
    async () => [],
  ),
}));

vi.mock("../reminder/shared", () => ({
  getWorkerPrisma: vi.fn(() => ({
    withingsConnection: { findMany: (...a: unknown[]) => ecgFindMany(...a) },
  })),
}));

import {
  handleWithingsEcgSync,
  type WithingsEcgSyncPayload,
} from "../reminder/withings-sync";
import { WITHINGS_ECG_SYNC_CRON } from "../integration-poll-queues";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "../registry/__tests__/registry-helpers";
import { WITHINGS_ECG_SYNC_QUEUE } from "../withings-ecg-queue";

function job(data: WithingsEcgSyncPayload): Job<WithingsEcgSyncPayload> {
  return { data } as Job<WithingsEcgSyncPayload>;
}

beforeEach(() => {
  vi.clearAllMocks();
  ecgFindMany.mockResolvedValue([]);
  isReauthRequired.mockResolvedValue(false);
});

describe("handleWithingsEcgSync", () => {
  it("a webhook job (userId + window) does a targeted date-windowed sync", async () => {
    syncUserEcg.mockResolvedValue(1);
    const queued = job({
      userId: "user-1",
      eventId: "wu-1:1:1715000000:1715000060",
      triggeredAt: "2026-07-20T12:00:00.000Z",
      startdate: 1715000000,
      enddate: 1715000060,
    });

    await expect(handleWithingsEcgSync([queued])).resolves.toEqual({
      ok: true,
      did: {
        provider: "withings",
        outcome: "useful",
        total: 1,
        users_synced: 1,
        users_complete: 1,
        users_partial: 0,
        users_failed: 0,
        users_parked: 0,
        users_skipped: 0,
        users_useful: 1,
        users_clean_zero: 0,
        users_retryable: 0,
        downstream_failed: 0,
        measurements_imported: 1,
      },
    });

    expect(ecgFindMany).not.toHaveBeenCalled();
    expect(syncUserEcg).toHaveBeenCalledTimes(1);
    expect(syncUserEcg).toHaveBeenCalledWith("user-1", {
      startdate: 1715000000,
      enddate: 1715000060,
    });
  });

  it("a payload-less cron tick walks the connection cohort with the default window", async () => {
    // The catch-net that lets a watch-only account (no scale, appli 54
    // unsubscribed) pull its ECG strips: no userId → iterate every connection
    // with `syncUserEcg(userId)` (default trailing-30-day window).
    ecgFindMany.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    syncUserEcg.mockResolvedValue(0);

    await handleWithingsEcgSync([job({} as WithingsEcgSyncPayload)]);

    expect(ecgFindMany).toHaveBeenCalledTimes(1);
    expect(syncUserEcg).toHaveBeenCalledTimes(2);
    expect(syncUserEcg).toHaveBeenNthCalledWith(1, "a", {});
    expect(syncUserEcg).toHaveBeenNthCalledWith(2, "b", {});
  });

  it("one user's failure never starves the rest of the cohort", async () => {
    ecgFindMany.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    syncUserEcg.mockResolvedValue(0);
    syncUserEcg.mockRejectedValueOnce(new Error("boom for a"));

    // Per-user catch-and-warn (mirrors the activity / sleep handlers): the
    // pass ran, so the job is done and the failing user rides out as a
    // `users_failed` count. The leaf records its own ledger failure, so
    // honesty is preserved without rejecting the whole batch.
    await expect(
      handleWithingsEcgSync([job({} as WithingsEcgSyncPayload)]),
    ).resolves.toEqual({
      ok: true,
      did: {
        provider: "withings",
        outcome: "clean_zero",
        total: 2,
        users_synced: 1,
        users_complete: 1,
        users_partial: 0,
        users_failed: 1,
        users_parked: 0,
        users_skipped: 0,
        users_useful: 0,
        users_clean_zero: 1,
        users_retryable: 1,
        downstream_failed: 0,
        measurements_imported: 0,
      },
    });
    expect(syncUserEcg).toHaveBeenCalledTimes(2);
  });
});

describe("withings ECG queue registration", () => {
  it("deduplicates only queued replays and admits a rescue after work starts", async () => {
    expect(groupOf(WITHINGS_ECG_SYNC_QUEUE).name).toBe("integration_sync");
    const definition = jobOf(WITHINGS_ECG_SYNC_QUEUE);
    expect(definition.policy?.policy).toBe("short");
    expect(definition.cron).toBe(WITHINGS_ECG_SYNC_CRON);
    expect(await loadedHandler(WITHINGS_ECG_SYNC_QUEUE)).toBe(
      handleWithingsEcgSync,
    );
  });
});
