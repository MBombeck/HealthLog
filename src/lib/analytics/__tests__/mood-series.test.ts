/**
 * v1.17.1 — the single mood engine `buildMoodDailySeries`.
 *
 * Pins the one-engine contract: the dashboard snapshot (`buildMoodBlock`)
 * and the `/api/mood/analytics` route both read through this function, so
 * the same number must read identically on dashboard + insights. Covers
 * the rollup fast-path and the legacy live fallback, and asserts the live
 * fallback collapses multi-entry days into the daily mean exactly once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: { findMany: vi.fn() },
    moodEntryRollup: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/rollups/mood-rollups", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/rollups/mood-rollups")
  >("@/lib/rollups/mood-rollups");
  return {
    ...actual,
    ensureUserMoodRollupsFresh: vi
      .fn()
      .mockResolvedValue({ recomputed: false }),
    readMoodDayRollups: vi.fn(),
  };
});

import { buildMoodDailySeries } from "../mood-series";
import { prisma } from "@/lib/db";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import {
  pendingBackgroundTaskCount,
  settleBackgroundTasks,
} from "@/lib/logging/background-tasks";

beforeEach(() => {
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(readMoodDayRollups).mockResolvedValue([] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildMoodDailySeries", () => {
  it("reads the rollup tier and skips the raw walk when DAY rows exist", async () => {
    vi.mocked(readMoodDayRollups).mockResolvedValue([
      { bucketStart: new Date("2026-06-01T00:00:00Z"), mean: 4, count: 2 },
      { bucketStart: new Date("2026-06-02T00:00:00Z"), mean: 3, count: 1 },
    ] as never);

    const series = await buildMoodDailySeries("user-1");

    expect(series.source).toBe("rollup");
    expect(prisma.moodEntry.findMany).not.toHaveBeenCalled();
    expect(series.entries).toEqual([
      { date: "2026-06-01", score: 4, samples: 2 },
      { date: "2026-06-02", score: 3, samples: 1 },
    ]);
    // entryCount sums the per-day samples (2 + 1).
    expect(series.entryCount).toBe(3);
    expect(series.summary.count).toBe(2);
  });

  it("falls back to the live walk once and collapses multi-entry days to the daily mean", async () => {
    vi.mocked(readMoodDayRollups).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { date: "2026-06-01", score: 5 },
      { date: "2026-06-01", score: 3 },
      { date: "2026-06-02", score: 4 },
    ] as never);

    const series = await buildMoodDailySeries("user-1");

    expect(series.source).toBe("live");
    // Two distinct calendar days; day one is the mean of its two entries.
    expect(series.entries).toEqual([
      { date: "2026-06-01", score: 4, samples: 2 },
      { date: "2026-06-02", score: 4, samples: 1 },
    ]);
    expect(series.entryCount).toBe(3);
    // summarize sees one DataPoint per day, not per raw entry.
    expect(series.summary.count).toBe(2);
  });

  it("bounds the live walk to the window the rollup read covers", async () => {
    await buildMoodDailySeries("user-1");
    const [rollupUser, since] = vi.mocked(readMoodDayRollups).mock.calls[0] as [
      string,
      Date,
    ];
    expect(rollupUser).toBe("user-1");
    const args = vi.mocked(prisma.moodEntry.findMany).mock.calls[0]?.[0] as {
      where: { moodLoggedAt?: { gte: Date } };
    };
    expect(args.where.moodLoggedAt?.gte).toEqual(since);
  });

  it("returns an empty series for a user with no rollups and no raw entries", async () => {
    const series = await buildMoodDailySeries("user-1");
    expect(series.entries).toEqual([]);
    expect(series.entryCount).toBe(0);
    // An empty table reads as the rollup tier for annotation parity.
    expect(series.source).toBe("rollup");
    expect(series.summary.count).toBe(0);
  });

  it("files the rollup warm-up with the background registry", async () => {
    // The warm-up is not awaited by the read, so a caller that has to know
    // when the request's work is over (the statement counter, the suite's
    // settle hook) can only see it through the registry. Left unregistered,
    // a stale account's full recompute bled into whatever ran next.
    let release: () => void = () => {};
    vi.mocked(ensureUserMoodRollupsFresh).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ recomputed: true });
        }),
    );

    await buildMoodDailySeries("user-1");

    expect(ensureUserMoodRollupsFresh).toHaveBeenCalledWith("user-1");
    expect(pendingBackgroundTaskCount()).toBe(1);
    release();
    await settleBackgroundTasks();
    expect(pendingBackgroundTaskCount()).toBe(0);
  });
});
