/**
 * Pins the verdict gate of `runGoogleHealthBackfillForUser`: the
 * `backfillCompletedAt` marker may only be stamped after a CLEAN full-history
 * run. `syncUserGoogleHealth` swallows per-resource errors into its verdict —
 * before the gate, ANY run (partial hard failure, parked no-op) stamped the
 * marker and the pg-boss `retryLimit: 3` was dead code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  prismaMock,
  syncUserGoogleHealthMock,
  isParkedMock,
  bossSend,
  resumeState,
} = vi.hoisted(() => ({
  prismaMock: {
    googleHealthConnection: {
      findMany: vi.fn(),
      findUnique: vi.fn(
        async (): Promise<{
          backfillProgress: unknown;
          backfillCompletedAt: Date | null;
        } | null> => null,
      ),
      update: vi.fn(),
    },
  },
  syncUserGoogleHealthMock: vi.fn(),
  isParkedMock: vi.fn(async () => false),
  bossSend: vi.fn(),
  // Collections the mocked walk "finishes" in this attempt, added to the
  // resume set the way `runGoogleHealthCollection` adds them.
  resumeState: {
    finishes: [] as string[],
    doneBefore: [] as string[],
    /** Collections whose resume edge the mocked walk moves. */
    advances: [] as string[],
    collections: [] as Array<{ key: string; status: string }>,
    /** Collections the mocked walk ends short for good. */
    ends: [] as string[],
    /** Collections the mocked walk parks after a first end without progress. */
    parks: [] as string[],
    /** When the parked ones are due again (epoch ms). */
    retryDueAt: 0,
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

vi.mock("@/lib/google-health/backfill-progress", () => ({
  readGoogleHealthBackfillProgress: () => ({
    done: new Set<string>(resumeState.doneBefore),
    cursors: new Map(),
    edgeFilterUnsupported: new Set<string>(),
    ended: new Map(),
  }),
  googleHealthBackfillProgressAfterCompletion: (ended: Map<string, unknown>) =>
    ended.size > 0 ? { ended: Object.fromEntries(ended) } : null,
  googleHealthBackfillRetryPending: (
    ended: Map<string, { reason: string; attempts?: number }>,
  ) => {
    const keys = [...ended]
      .filter(([, e]) => e.reason === "no_progress" && (e.attempts ?? 1) < 2)
      .map(([key]) => key);
    return keys.length > 0 ? { keys, dueAt: resumeState.retryDueAt } : null;
  },
}));

vi.mock("@/lib/google-health/sync-core", () => ({
  GOOGLE_HEALTH_INTEGRATION_KEY: "google-health",
  runWithGoogleHealthBackfillResume: async (
    _userId: string,
    done: Set<string>,
    fn: () => Promise<unknown>,
    _cursors: unknown,
    _unsupported: unknown,
    ended: Map<string, unknown>,
  ) => {
    const result = await fn();
    for (const key of resumeState.finishes) done.add(key);
    for (const key of resumeState.ends) {
      // Final: finished the way `runGoogleHealthCollection` finishes it.
      ended.set(key, {
        type: "PULSE",
        at: "2024-05-11T00:00:00.000Z",
        reason: "no_progress",
        attempts: 2,
      });
      done.add(key);
    }
    for (const key of resumeState.parks) {
      ended.set(key, {
        type: "PULSE",
        at: "2024-05-11T00:00:00.000Z",
        reason: "no_progress",
        attempts: 1,
      });
    }
    return {
      result,
      skipped: [],
      advanced: new Map(resumeState.advances.map((key) => [key, null])),
      collections: resumeState.collections,
      ended,
    };
  },
}));
vi.mock("@/lib/google-health/sync", () => ({
  isGoogleHealthParked: isParkedMock,
  syncUserGoogleHealth: (...a: unknown[]) => syncUserGoogleHealthMock(...a),
}));

import {
  GOOGLE_HEALTH_BACKFILL_MAX_SLICE,
  GOOGLE_HEALTH_BACKFILL_THROTTLED_DELAY_SECONDS,
  googleHealthBackfillRetryKey,
  runGoogleHealthBackfillForUser,
} from "../google-health-backfill";
import { INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS } from "@/lib/jobs/integration-backfill-admission";
import {
  LANE_DEFER_SECONDS,
  LANE_YIELD_DELAY_SECONDS,
} from "@/lib/jobs/heavy-lane";
import { GOOGLE_HEALTH_COLLECTION_KEYS } from "@/lib/google-health/collection-keys";
import { forEachDataPointPage } from "@/lib/google-health/data-points";
import { runWithGoogleHealthClientOutcome } from "@/lib/google-health/budget";
import { GOOGLE_HEALTH_DATA_TYPES } from "@/lib/google-health/mappers";

beforeEach(() => {
  vi.clearAllMocks();
  isParkedMock.mockResolvedValue(false);
  prismaMock.googleHealthConnection.update.mockResolvedValue({});
  prismaMock.googleHealthConnection.findUnique.mockResolvedValue(null);
  bossSend.mockResolvedValue("job-next");
  resumeState.finishes = [];
  resumeState.doneBefore = [];
  resumeState.advances = [];
  resumeState.collections = [];
  resumeState.ends = [];
  resumeState.parks = [];
  resumeState.retryDueAt = 0;
});

describe("runGoogleHealthBackfillForUser — verdict-gated marker", () => {
  it("stamps backfillCompletedAt after a CLEAN full-history run", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 42, failed: false });

    const { imported } = await runGoogleHealthBackfillForUser("u1");

    expect(imported).toBe(42);
    expect(syncUserGoogleHealthMock).toHaveBeenCalledWith("u1", {
      fullSync: true,
      waitForLockMs: expect.any(Number),
    });
    const updateArg = prismaMock.googleHealthConnection.update.mock
      .calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.backfillCompletedAt).toBeInstanceOf(Date);
    // The resume note goes with the stamp: a later backfill starts over.
    expect(updateArg.data).toHaveProperty("backfillProgress");
  });

  it("throws without stamping when another sync of the account holds it", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({
      imported: 0,
      failed: true,
      busy: true,
    });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /another sync of the account is running/,
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a failed verdict THROWS without stamping — pg-boss retries become real", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 7, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isParkedMock.mockResolvedValue(true);

    await expect(runGoogleHealthBackfillForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserGoogleHealthMock).not.toHaveBeenCalled();
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("stops the walk when its budget runs out and throws without stamping", async () => {
    // An endless heart-rate stream: every page names a next one.
    safeFetchMock.mockImplementation(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ dataPoints: [{}], nextPageToken: "more" }),
    }));
    // The real walk under the sync mock, reporting what the real sync reports
    // for a truncated resource.
    syncUserGoogleHealthMock.mockImplementation(async () => {
      const { outcome } = await runWithGoogleHealthClientOutcome(() =>
        forEachDataPointPage(
          GOOGLE_HEALTH_DATA_TYPES.heartRate,
          "token",
          "fetchHeartRate",
          { maxPages: 10_000 },
          () => {},
        ),
      );
      return { imported: outcome.fetched, failed: outcome.truncated };
    });
    let asked = 0;
    const shouldStop = () => ++asked > 3;

    await expect(
      runGoogleHealthBackfillForUser("u1", shouldStop),
    ).rejects.toThrow(/incomplete/);
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });
});

/**
 * A long history walks in slices. A slice that finished more collections than
 * it started with is progressing, not failing: it queues the next slice and
 * ends quietly, without the error line or the failure count. Only a slice that
 * finished nothing new is stuck and keeps throwing.
 */
describe("runGoogleHealthBackfillForUser — slices", () => {
  it("continues a progressing slice instead of failing it", async () => {
    resumeState.doneBefore = ["steps"];
    resumeState.finishes = ["sleep", "weight"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 9, failed: true });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 2),
    ).resolves.toEqual({
      imported: 9,
      continued: true,
    });

    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = bossSend.mock.calls[0]!;
    expect(queue).toBe("integration-backfill-admission");
    expect(payload).toMatchObject({
      kind: "google-health-backfill",
      data: { userId: "u1", slice: 3 },
    });
    // Its own key, so the exclusive policy does not swallow it while this
    // slice is still active.
    expect(options).toMatchObject({
      singletonKey: "google-health-backfill|u1|slice-3",
      startAfter: expect.any(Number),
    });
    // Not complete: no stamp.
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("still throws for a slice that finished nothing new", async () => {
    resumeState.doneBefore = ["steps"];
    resumeState.finishes = [];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 3, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("throws rather than drop the work when the next slice cannot be queued", async () => {
    resumeState.finishes = ["sleep"];
    bossSend.mockResolvedValue(null);
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 1, failed: true });

    await expect(runGoogleHealthBackfillForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
  });

  it("fails a slice past the ceiling without walking or queueing", async () => {
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 1, failed: true });
    resumeState.finishes = ["sleep"];

    await expect(
      runGoogleHealthBackfillForUser(
        "u1",
        undefined,
        GOOGLE_HEALTH_BACKFILL_MAX_SLICE + 1,
      ),
    ).rejects.toThrow(/past the ceiling/);
    expect(syncUserGoogleHealthMock).not.toHaveBeenCalled();
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("does not queue a slice past the ceiling even when this one progressed", async () => {
    resumeState.finishes = ["sleep"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 1, failed: true });

    await expect(
      runGoogleHealthBackfillForUser(
        "u1",
        undefined,
        GOOGLE_HEALTH_BACKFILL_MAX_SLICE,
      ),
    ).rejects.toThrow(/incomplete/);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("bounds the chain in time, not in pages", () => {
    // Every collection once, sixty days of five-minute slices back to back,
    // and two of slack. No page count: a dense history must not run into it
    // (#1220).
    expect(GOOGLE_HEALTH_BACKFILL_MAX_SLICE).toBe(17 + (60 * 24 * 60) / 5 + 2);
  });

  it("continues a slice that only ended a collection short", async () => {
    resumeState.ends = ["fetchHeartRate"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: true });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 4),
    ).resolves.toEqual({ imported: 0, continued: true });
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it("keeps where a collection ended when it stamps the marker", async () => {
    resumeState.ends = ["fetchHeartRate"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: false });

    await runGoogleHealthBackfillForUser("u1", undefined, 2);
    const data = prismaMock.googleHealthConnection.update.mock.calls[0]![0]
      .data as Record<string, unknown>;
    expect(data.backfillCompletedAt).toBeInstanceOf(Date);
    expect(data.backfillProgress).toEqual({
      ended: {
        fetchHeartRate: {
          type: "PULSE",
          at: "2024-05-11T00:00:00.000Z",
          reason: "no_progress",
          attempts: 2,
        },
      },
    });
  });

  it("continues a slice that only parked a collection for another try", async () => {
    resumeState.parks = ["fetchHeartRate"];
    resumeState.retryDueAt = Date.now() + 24 * 3_600_000;
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: true });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 4),
    ).resolves.toEqual({ imported: 0, continued: true });
    // Other collections are still to walk: the next slice comes as usual.
    expect(bossSend.mock.calls[0]![2]).toMatchObject({
      startAfter: INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
    });
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("waits for the retry instead of stamping when only a parked collection is left", async () => {
    resumeState.doneBefore = GOOGLE_HEALTH_COLLECTION_KEYS.filter(
      (k) => k !== "fetchHeartRate",
    );
    resumeState.parks = ["fetchHeartRate"];
    resumeState.retryDueAt = Date.now() + 10 * 3_600_000;
    // The parked collection was skipped as not yet due: a clean run.
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: false });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 7),
    ).resolves.toEqual({ imported: 0, continued: true });
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
    expect(bossSend).toHaveBeenCalledTimes(1);
    const startAfter = (bossSend.mock.calls[0]![2] as { startAfter: number })
      .startAfter;
    expect(Math.abs(startAfter - 10 * 3600)).toBeLessThanOrEqual(2);
    expect(bossSend.mock.calls[0]![1]).toMatchObject({
      data: { slice: 8 },
    });
  });

  it("keys a waiting retry on when it is due, so a boot's slice cannot start a second chain", async () => {
    resumeState.doneBefore = GOOGLE_HEALTH_COLLECTION_KEYS.filter(
      (k) => k !== "fetchHeartRate",
    );
    resumeState.parks = ["fetchHeartRate"];
    resumeState.retryDueAt = Date.now() + 20 * 3_600_000;
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: false });

    // The slice that parked the collection, then a boot's first slice meeting
    // the same wait from the same note.
    await runGoogleHealthBackfillForUser("u1", undefined, 7);
    await runGoogleHealthBackfillForUser("u1", undefined, 0);

    const keys = bossSend.mock.calls.map(
      (call) => (call[2] as { singletonKey: string }).singletonKey,
    );
    expect(keys).toEqual([
      googleHealthBackfillRetryKey("u1", resumeState.retryDueAt),
      googleHealthBackfillRetryKey("u1", resumeState.retryDueAt),
    ]);
    expect(keys[0]).toBe(
      `google-health-backfill|u1|retry-${new Date(resumeState.retryDueAt).toISOString()}`,
    );
  });

  it("sends a retry that is already due as an ordinary next slice", async () => {
    resumeState.doneBefore = GOOGLE_HEALTH_COLLECTION_KEYS.filter(
      (k) => k !== "fetchHeartRate",
    );
    resumeState.parks = ["fetchHeartRate"];
    resumeState.retryDueAt = Date.now() - 1_000;
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: false });

    await runGoogleHealthBackfillForUser("u1", undefined, 7);
    expect(bossSend.mock.calls[0]![2]).toMatchObject({
      singletonKey: "google-health-backfill|u1|slice-8",
      startAfter: INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
    });
  });

  it("does not stamp over a parked collection when the retry cannot be queued", async () => {
    resumeState.doneBefore = GOOGLE_HEALTH_COLLECTION_KEYS.filter(
      (k) => k !== "fetchHeartRate",
    );
    resumeState.parks = ["fetchHeartRate"];
    resumeState.retryDueAt = Date.now() + 3_600_000;
    bossSend.mockResolvedValue(null);
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: false });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 7),
    ).resolves.toEqual({ imported: 0 });
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("continues a slice that only moved a collection's edge", async () => {
    resumeState.advances = ["fetchHeartRate"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 900, failed: true });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 7),
    ).resolves.toEqual({ imported: 900, continued: true });
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend.mock.calls[0]![1]).toMatchObject({
      data: { userId: "u1", slice: 8 },
    });
    expect(bossSend.mock.calls[0]![2]).toMatchObject({
      startAfter: INTEGRATION_BACKFILL_CONTINUATION_DELAY_SECONDS,
    });
  });

  it("queues the next slice past the waiting job's return after giving way", async () => {
    resumeState.advances = ["fetchHeartRate"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 10, failed: true });
    const client = await import("@/lib/google-health/budget");
    const spy = vi
      .spyOn(client, "googleHealthSliceBudget")
      .mockImplementation(() => ({
        ms: 300_000,
        deadline: null,
        maxPages: 500,
        pages: 3,
        skippedPages: 0,
        stopReason: "lane_wanted",
        now: Date.now,
        yieldWanted: () => true,
      }));
    try {
      await expect(runGoogleHealthBackfillForUser("u1")).resolves.toMatchObject(
        { continued: true },
      );
    } finally {
      spy.mockRestore();
    }
    expect(bossSend.mock.calls[0]![2]).toMatchObject({
      startAfter: LANE_YIELD_DELAY_SECONDS,
    });
    expect(LANE_YIELD_DELAY_SECONDS).toBeGreaterThan(LANE_DEFER_SECONDS);
  });

  it("waits longer before the next slice when this one ended on a rate limit", async () => {
    resumeState.advances = ["fetchHeartRate"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 10, failed: true });
    // The slice ended the way a resumable walk ends it when Google keeps
    // answering 429 past every wait.
    const client = await import("@/lib/google-health/budget");
    const spy = vi
      .spyOn(client, "googleHealthSliceBudget")
      .mockImplementation(() => ({
        ms: 300_000,
        deadline: null,
        maxPages: 500,
        pages: 3,
        skippedPages: 0,
        stopReason: "rate_limited",
        now: Date.now,
        yieldWanted: () => false,
      }));
    try {
      await runGoogleHealthBackfillForUser("u1");
    } finally {
      spy.mockRestore();
    }
    expect(bossSend.mock.calls[0]![2]).toMatchObject({
      startAfter: GOOGLE_HEALTH_BACKFILL_THROTTLED_DELAY_SECONDS,
    });
  });

  it("names where it is stuck when a slice moved nothing", async () => {
    resumeState.collections = [
      { key: "fetchWeight", status: "done" },
      { key: "fetchHeartRate", status: "failed" },
      { key: "fetchBloodGlucose", status: "deferred" },
    ];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 0, failed: true });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 3),
    ).rejects.toThrow(
      /marker not stamped \(no progress in slice 3; fetchHeartRate:failed,fetchBloodGlucose:deferred\)/,
    );
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("stamps the marker on the slice that finishes the history", async () => {
    resumeState.doneBefore = ["steps", "sleep"];
    resumeState.finishes = ["weight"];
    syncUserGoogleHealthMock.mockResolvedValue({ imported: 4, failed: false });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 5),
    ).resolves.toEqual({
      imported: 4,
    });
    expect(bossSend).not.toHaveBeenCalled();
    expect(
      prismaMock.googleHealthConnection.update.mock.calls[0]![0].data
        .backfillCompletedAt,
    ).toBeInstanceOf(Date);
  });

  it("walks nothing again once an earlier slice completed the import", async () => {
    prismaMock.googleHealthConnection.findUnique.mockResolvedValue({
      backfillProgress: null,
      backfillCompletedAt: new Date(),
    });

    await expect(
      runGoogleHealthBackfillForUser("u1", undefined, 4),
    ).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserGoogleHealthMock).not.toHaveBeenCalled();
  });
});
