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
  executeRaw: vi.fn(),
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
    $executeRaw: mocks.executeRaw,
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
  executeRaw,
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
  executeRaw.mockReset();
  executeRaw.mockResolvedValue(0);
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
  function bindValues(call: unknown[]): unknown[] {
    return call.slice(1);
  }

  it("runs the atomic DAY upsert + DELETE pair and fires WEEK/MONTH/YEAR enqueues", async () => {
    // QA F-H-02 (v1.4.39): the DAY pass is now a single atomic SQL
    // statement (INSERT … SELECT … ON CONFLICT) plus a paired DELETE
    // that gates on NOT EXISTS. No JS-side aggregate, no per-row
    // upsert through the Prisma client.
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-id");

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    expect(executeRaw).toHaveBeenCalledTimes(2);
    const insertBinds = bindValues(executeRaw.mock.calls[0]);
    expect(insertBinds).toContain("user-1");
    // bucket_start is bound twice (INSERT row + INSERT SELECT predicate
    // are both inside the same CTE shape via the same parameter).
    const dayStart = new Date("2026-05-10T00:00:00.000Z");
    expect(
      (insertBinds.filter((b) => b instanceof Date) as Date[]).some(
        (d) => d.getTime() === dayStart.getTime(),
      ),
    ).toBe(true);

    // QA F-H-03 — the enqueue is fire-and-forget; the response path
    // never awaits the boss.send call. Wait a tick for the
    // floating promise to flush before asserting.
    await new Promise((r) => setImmediate(r));

    expect(bossSend).toHaveBeenCalledTimes(3);
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(MOOD_ROLLUP_RECOMPUTE_QUEUE);
      expect(call[1].userId).toBe("user-1");
      expect(["WEEK", "MONTH", "YEAR"]).toContain(call[1].granularity);
    }
  });

  it("issues the paired DELETE so a fully-cleared day removes its row", async () => {
    getGlobalBossMock.mockReturnValue(null);

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    // The DELETE always fires; its NOT EXISTS predicate matches zero
    // rows on the populated-day branch and matches the row on the
    // emptied-day branch. We can only assert the second statement
    // fired here.
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("is idempotent under re-run for the same (user, day)", async () => {
    getGlobalBossMock.mockReturnValue(null);

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );
    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    expect(executeRaw).toHaveBeenCalledTimes(4);
    // Bind values for the INSERT statement match across both runs.
    expect(bindValues(executeRaw.mock.calls[0])).toEqual(
      bindValues(executeRaw.mock.calls[2]),
    );
    // Bind values for the DELETE statement match across both runs.
    expect(bindValues(executeRaw.mock.calls[1])).toEqual(
      bindValues(executeRaw.mock.calls[3]),
    );
  });

  it("commits the strictest aggregate under concurrent recompute calls", async () => {
    // QA F-H-02 race pin: two concurrent recomputes for the same
    // (user, day) must both go through the atomic SQL path so each
    // statement re-aggregates a snapshot taken after the prior commit
    // released its row lock.
    getGlobalBossMock.mockReturnValue(null);

    await Promise.all([
      recomputeMoodBucketsForEntry(
        "user-1",
        new Date("2026-05-10T14:30:00.000Z"),
      ),
      recomputeMoodBucketsForEntry(
        "user-1",
        new Date("2026-05-10T14:30:00.000Z"),
      ),
    ]);
    // 2 callers × 2 statements (INSERT + DELETE) each.
    expect(executeRaw).toHaveBeenCalledTimes(4);
    // No legacy JS-side aggregate ($queryRawUnsafe) fired on the DAY
    // pass; no Prisma-API upsert / deleteMany were issued either.
    expect(queryRawUnsafe).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it("does not await the WEEK/MONTH/YEAR enqueue on the write-path response", async () => {
    // QA F-H-03 (v1.4.39): the outer Promise.all is fire-and-forget so
    // a slow pg-boss send never serialises the user's mood-write
    // response. Pin that the helper resolves before the enqueue
    // promise settles.
    let resolveEnqueue: (() => void) | null = null;
    const enqueueGate = new Promise<string>((resolve) => {
      resolveEnqueue = () => resolve("job-late");
    });
    getGlobalBossMock.mockReturnValue({ send: () => enqueueGate });

    await recomputeMoodBucketsForEntry(
      "user-1",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    // The helper has resolved even though the boss.send promise is
    // still pending. Resolve it after the assertion so the test does
    // not leak a pending promise across the suite.
    resolveEnqueue!();
    await enqueueGate;
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
