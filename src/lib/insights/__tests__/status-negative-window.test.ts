/**
 * #1279 — the negative-cache window of a status note grows with the
 * generations in a row that ended without a note, is not moved or counted
 * by a failure inside it, resets when the person asks again, and is what the
 * provider chokepoint reads before any generation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    insightStatusCache: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
  },
}));

import {
  STATUS_NEGATIVE_WINDOW_BASE_MS,
  clearStatusNegativeWindows,
  statusNegativeWindowMs,
  statusNoteCoolingDown,
  writeStatusNegativeWindow,
} from "../status-negative-window";

const TODAY = "2026-05-31";
const MINUTE = 60 * 1000;

interface UpsertArgs {
  where: { userId_metric_locale: Record<string, string> };
  create: Record<string, unknown>;
  update: { retryAt: Date; negativeReason: string; failureStreak: number };
}

function written(): UpsertArgs {
  return upsert.mock.calls[0][0] as UpsertArgs;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("writeStatusNegativeWindow", () => {
  it("opens a five-minute window without touching the stored note", async () => {
    findUnique.mockResolvedValue(null);
    const before = Date.now();
    await writeStatusNegativeWindow({
      userId: "u1",
      cacheAction: "insights.pulse-status.de",
      todayKey: TODAY,
      reason: "timeout",
    });
    expect(written().where.userId_metric_locale).toEqual({
      userId: "u1",
      metric: "pulse",
      locale: "de",
    });
    // Only the window moves: a stall must not hide yesterday's text.
    expect(Object.keys(written().update).sort()).toEqual([
      "failureStreak",
      "negativeReason",
      "retryAt",
    ]);
    expect(written().update.negativeReason).toBe("timeout");
    expect(written().update.failureStreak).toBe(1);
    const opened = written().update.retryAt.getTime() - before;
    expect(opened).toBeGreaterThanOrEqual(STATUS_NEGATIVE_WINDOW_BASE_MS);
    expect(opened).toBeLessThan(STATUS_NEGATIVE_WINDOW_BASE_MS + 5000);
  });

  it("grows the window with each failure in a row", async () => {
    findUnique.mockResolvedValue({
      retryAt: new Date(Date.now() - 1000),
      failureStreak: 3,
    });
    const before = Date.now();
    await writeStatusNegativeWindow({
      userId: "u1",
      cacheAction: "insights.metric:HEART_RATE-status.en",
      todayKey: TODAY,
      reason: "error",
    });
    expect(written().update.failureStreak).toBe(4);
    expect(written().update.retryAt.getTime() - before).toBeGreaterThanOrEqual(
      40 * MINUTE,
    );
  });

  it("neither moves nor counts a window that is still open", async () => {
    findUnique.mockResolvedValue({
      retryAt: new Date(Date.now() + MINUTE),
      failureStreak: 2,
    });
    await writeStatusNegativeWindow({
      userId: "u1",
      cacheAction: "insights.weight-status.en",
      todayKey: TODAY,
      reason: "error",
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("ignores a name that is not a status note", async () => {
    await writeStatusNegativeWindow({
      userId: "u1",
      cacheAction: "workouts.insight",
      todayKey: TODAY,
      reason: "error",
    });
    expect(findUnique).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("statusNegativeWindowMs", () => {
  it("doubles from five minutes to a two-hour ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 30].map(statusNegativeWindowMs)).toEqual(
      [5, 10, 20, 40, 80, 120, 120, 120].map((m) => m * MINUTE),
    );
  });
});

describe("statusNoteCoolingDown", () => {
  it("is true only while the window is open, and reads nothing for other names", async () => {
    findUnique.mockResolvedValueOnce({
      retryAt: new Date(Date.now() + MINUTE),
    });
    expect(await statusNoteCoolingDown("u1", "insights.weight-status.en")).toBe(
      true,
    );
    findUnique.mockResolvedValueOnce({ retryAt: new Date(Date.now() - 1) });
    expect(await statusNoteCoolingDown("u1", "insights.weight-status.en")).toBe(
      false,
    );
    expect(await statusNoteCoolingDown("u1", "workouts.insight")).toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("clearStatusNegativeWindows", () => {
  it("closes every open window and streak of one record", async () => {
    await clearStatusNegativeWindows("u1");
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        OR: [{ retryAt: { not: null } }, { failureStreak: { gt: 0 } }],
      },
      data: { retryAt: null, negativeReason: null, failureStreak: 0 },
    });
  });

  it("never throws: the windows lapse on their own", async () => {
    updateMany.mockRejectedValue(new Error("pool exhausted"));
    await expect(clearStatusNegativeWindows("u1")).resolves.toBeUndefined();
  });
});
