/**
 * v1.4.39 W-MOOD — unit tests for the persistent mood-rollup
 * populator.
 *
 * `prisma` is mocked at the module level so we can pin:
 *   - the DAY-bucket sync recompute writes through the upsert path,
 *   - `recomputeMoodBucketsForEntry` is idempotent under re-run,
 *   - `enqueueMoodRollupRecompute` calls `boss.send` with the
 *     documented queue + singleton-key shape, and is a silent no-op
 *     when no boss is attached,
 *   - `ensureUserMoodRollupsFresh` short-circuits on fresh data and
 *     dedups concurrent callers onto one in-flight promise,
 *   - the boot-time backfill discovers users with mood entries but
 *     no rollup coverage and enqueues one job per uncovered user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories run BEFORE module-level statements due to hoisting,
// so the mock fns must live inside the factory closure. We re-export
// them through `vi.hoisted` so the test body can reach them after.
const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findFirstMoodEntry: vi.fn(),
  bossSend: vi.fn(),
  getGlobalBossMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    moodEntryRollup: {
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
    moodEntry: {
      findFirst: mocks.findFirstMoodEntry,
    },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => mocks.getGlobalBossMock(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { annotate } from "@/lib/logging/context";

const {
  queryRaw,
  queryRawUnsafe,
  upsert,
  deleteMany,
  findFirst,
  findFirstMoodEntry,
  bossSend,
  getGlobalBossMock,
} = mocks;
// `findMany` is wired in so indirect lookups don't throw; the
// populator tests below exercise the `$queryRawUnsafe` + upsert
// paths so the reference stays unused inside this file.
void mocks.findMany;
void queryRaw;

import {
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
  _resetEnsureUserMoodRollupsFreshInFlightForTests,
  enqueueBootTimeMoodRollupBackfill,
  enqueueMoodRollupRecompute,
  ensureUserMoodRollupsFresh,
  recomputeMoodBucketsForEntry,
} from "../rollups";

beforeEach(() => {
  queryRaw.mockReset();
  queryRawUnsafe.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
  findFirst.mockReset();
  mocks.findMany.mockReset();
  findFirstMoodEntry.mockReset();
  bossSend.mockReset();
  getGlobalBossMock.mockReset();
  // v1.4.39 — clear the per-userId in-flight map so a previous
  // test's resolved promise does not short-circuit the next test.
  _resetEnsureUserMoodRollupsFreshInFlightForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recomputeMoodBucketsForEntry", () => {
  it("upserts the DAY rollup synchronously and enqueues WEEK/MONTH/YEAR", async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      {
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(3),
        mean: 4.0,
        min_score: 3,
        max_score: 5,
        sd: 0.82,
      },
    ]);
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-id");

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    // DAY pass — single upsert against the rollup table.
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArg = upsert.mock.calls[0][0];
    expect(upsertArg.where.userId_granularity_bucketStart.userId).toBe(
      "user-1",
    );
    expect(upsertArg.where.userId_granularity_bucketStart.granularity).toBe(
      "DAY",
    );
    expect(upsertArg.create.count).toBe(3);
    expect(upsertArg.create.mean).toBe(4);
    expect(upsertArg.create.minScore).toBe(3);
    expect(upsertArg.create.maxScore).toBe(5);
    expect(upsertArg.create.sd).toBeCloseTo(0.82);

    // WEEK / MONTH / YEAR — three enqueues against the worker queue.
    expect(bossSend).toHaveBeenCalledTimes(3);
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(MOOD_ROLLUP_RECOMPUTE_QUEUE);
      expect(call[1].userId).toBe("user-1");
      expect(["WEEK", "MONTH", "YEAR"]).toContain(call[1].granularity);
    }
  });

  it("deletes the DAY row when the post-mutation aggregate is empty", async () => {
    // Post-delete recompute: the day now has zero mood rows.
    queryRawUnsafe.mockResolvedValueOnce([]);
    getGlobalBossMock.mockReturnValue(null);

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where.userId).toBe("user-1");
    expect(deleteMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent under re-run for the same (user, day)", async () => {
    // Two consecutive calls with the same aggregate output should
    // result in two upserts that both carry the same payload — the
    // composite PK absorbs the second write into a no-op refresh on
    // the database side, but the populator must keep firing the
    // upsert each time (no in-memory dedup) so a real Postgres-side
    // change is picked up on the next call.
    const aggregate = [
      {
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(2),
        mean: 4.5,
        min_score: 4,
        max_score: 5,
        sd: 0.5,
      },
    ];
    queryRawUnsafe.mockResolvedValue(aggregate);
    getGlobalBossMock.mockReturnValue(null);

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );
    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    const firstPayload = upsert.mock.calls[0][0].create;
    const secondPayload = upsert.mock.calls[1][0].create;
    expect(firstPayload.count).toBe(secondPayload.count);
    expect(firstPayload.mean).toBe(secondPayload.mean);
    expect(firstPayload.minScore).toBe(secondPayload.minScore);
    expect(firstPayload.maxScore).toBe(secondPayload.maxScore);
  });
});

describe("enqueueMoodRollupRecompute", () => {
  it("is a silent no-op when no boss is attached", async () => {
    getGlobalBossMock.mockReturnValue(null);
    await enqueueMoodRollupRecompute({
      userId: "user-1",
      granularity: "WEEK",
      from: new Date("2026-05-04T00:00:00.000Z"),
      to: new Date("2026-05-11T00:00:00.000Z"),
    });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("sends with the documented queue + singleton-key shape", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-1");
    const from = new Date("2026-05-04T00:00:00.000Z");
    await enqueueMoodRollupRecompute({
      userId: "user-9",
      granularity: "WEEK",
      from,
      to: new Date("2026-05-11T00:00:00.000Z"),
    });
    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload, opts] = bossSend.mock.calls[0];
    expect(queue).toBe(MOOD_ROLLUP_RECOMPUTE_QUEUE);
    expect(payload.userId).toBe("user-9");
    expect(payload.granularity).toBe("WEEK");
    expect(payload.from).toBe(from.toISOString());
    expect(opts.singletonKey).toBe(`user-9|WEEK|${from.toISOString()}`);
  });
});

describe("ensureUserMoodRollupsFresh", () => {
  it("is a no-op when the user has no mood entries", async () => {
    findFirst.mockResolvedValueOnce(null);
    findFirstMoodEntry.mockResolvedValueOnce(null);
    const result = await ensureUserMoodRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("is a no-op when the rollup is already ahead of the newest mood entry", async () => {
    const rollupAt = new Date("2026-05-10T12:00:00.000Z");
    const entryAt = new Date("2026-05-10T11:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMoodEntry.mockResolvedValueOnce({
      updatedAt: entryAt,
      moodLoggedAt: entryAt,
    });
    const result = await ensureUserMoodRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("triggers a DAY-window recompute when stale", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const entryAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMoodEntry.mockResolvedValueOnce({
      updatedAt: entryAt,
      moodLoggedAt: entryAt,
    });
    queryRawUnsafe.mockResolvedValueOnce([]);
    const result = await ensureUserMoodRollupsFresh("user-1");
    expect(result.recomputed).toBe(true);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("swallows populator errors so the read path never fails", async () => {
    findFirst.mockRejectedValueOnce(new Error("pool exhausted"));
    findFirstMoodEntry.mockRejectedValueOnce(new Error("pool exhausted"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await ensureUserMoodRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
    consoleSpy.mockRestore();
  });

  it("dedups concurrent callers for the same userId onto one in-flight promise", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const entryAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValue({ computedAt: rollupAt });
    findFirstMoodEntry.mockResolvedValue({
      updatedAt: entryAt,
      moodLoggedAt: entryAt,
    });
    queryRawUnsafe.mockResolvedValue([]);

    const [a, b, c] = await Promise.all([
      ensureUserMoodRollupsFresh("user-1"),
      ensureUserMoodRollupsFresh("user-1"),
      ensureUserMoodRollupsFresh("user-1"),
    ]);
    expect(a.recomputed).toBe(true);
    expect(b.recomputed).toBe(true);
    expect(c.recomputed).toBe(true);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirstMoodEntry).toHaveBeenCalledTimes(1);
  });

  it("annotates the failure when the inner recompute throws", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const entryAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMoodEntry.mockResolvedValueOnce({
      updatedAt: entryAt,
      moodLoggedAt: entryAt,
    });
    queryRawUnsafe.mockRejectedValueOnce(new Error("deadlock detected"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ensureUserMoodRollupsFresh("user-1");

    expect(result.recomputed).toBe(false);
    expect(annotate).toHaveBeenCalledWith({
      meta: {
        mood_rollup_refresh_failed: true,
        mood_rollup_refresh_error: "deadlock detected",
      },
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("enqueueBootTimeMoodRollupBackfill", () => {
  it("is a silent no-op when no boss is attached", async () => {
    getGlobalBossMock.mockReturnValue(null);
    const result = await enqueueBootTimeMoodRollupBackfill();
    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("enqueues one full-fold job per user with mood entries but no rollups", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([
      { id: "user-a" },
      { id: "user-b" },
      { id: "user-c" },
    ]);
    bossSend
      .mockResolvedValueOnce("job-a")
      .mockResolvedValueOnce("job-b")
      .mockResolvedValueOnce("job-c");

    const result = await enqueueBootTimeMoodRollupBackfill();

    expect(result).toEqual({ enqueued: 3, skipped: 0, error: null });
    expect(bossSend).toHaveBeenCalledTimes(3);
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(MOOD_ROLLUP_FULL_BACKFILL_QUEUE);
    }
    expect(bossSend.mock.calls[0][2].singletonKey).toBe(
      "mood-boot-backfill|user-a",
    );
    expect(bossSend.mock.calls[1][2].singletonKey).toBe(
      "mood-boot-backfill|user-b",
    );
    expect(bossSend.mock.calls[2][2].singletonKey).toBe(
      "mood-boot-backfill|user-c",
    );
  });

  it("counts a `boss.send` returning null as 'skipped' (singleton coalesce)", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([{ id: "user-a" }, { id: "user-b" }]);
    bossSend.mockResolvedValueOnce(null).mockResolvedValueOnce("job-b");

    const result = await enqueueBootTimeMoodRollupBackfill();

    expect(result).toEqual({ enqueued: 1, skipped: 1, error: null });
  });

  it("returns the error message when the discovery query throws", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockRejectedValueOnce(new Error("pool exhausted"));

    const result = await enqueueBootTimeMoodRollupBackfill();

    expect(result.enqueued).toBe(0);
    expect(result.error).toBe("pool exhausted");
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("returns { enqueued: 0 } when no users need backfill", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([]);

    const result = await enqueueBootTimeMoodRollupBackfill();

    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(bossSend).not.toHaveBeenCalled();
  });
});
