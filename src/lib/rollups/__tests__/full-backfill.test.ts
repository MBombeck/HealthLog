/**
 * The full backfill's windowed fold and its handler (#1298): the windows it
 * cuts, the per-statement limit every window runs under, and how a run that
 * reaches its job budget hands the remaining years on instead of failing.
 *
 * The fold itself is mocked here; that the windows write exactly the buckets
 * one pass over the whole span writes is pinned against Postgres in
 * `tests/integration/rollup-full-backfill.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "pg-boss";

const mocks = vi.hoisted(() => ({
  recomputeUserRollups: vi.fn(),
  bossSend: vi.fn(),
  getGlobalBoss: vi.fn(),
}));

vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/rollups/measurement-rollups")
  >()),
  recomputeUserRollups: mocks.recomputeUserRollups,
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => mocks.getGlobalBoss(),
}));

import { handleRollupFullBackfill } from "@/lib/jobs/reminder/rollup-handlers";
import {
  foldUserRollupHistory,
  fullBackfillWindows,
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS,
  type RollupFullBackfillPayload,
} from "@/lib/rollups/full-backfill";
import { ROLLUP_FOLD_WINDOW_MS } from "@/lib/rollups/measurement-rollups";

const NOW = new Date("2026-10-29T10:00:00.000Z");

function job(
  data: Partial<RollupFullBackfillPayload> = {},
): Job<RollupFullBackfillPayload> {
  return {
    id: "job-1",
    name: ROLLUP_FULL_BACKFILL_QUEUE,
    data: { userId: "user-1", enqueuedAt: NOW.toISOString(), ...data },
    expireInSeconds: 3600,
    signal: new AbortController().signal,
  } as unknown as Job<RollupFullBackfillPayload>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.recomputeUserRollups.mockReset();
  mocks.recomputeUserRollups.mockResolvedValue({
    rowsUpserted: 10,
    durationMs: 1,
  });
  mocks.bossSend.mockReset();
  mocks.bossSend.mockResolvedValue("job-next");
  mocks.getGlobalBoss.mockReset();
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
});

describe("fullBackfillWindows", () => {
  it("cuts the span at UTC New Year, newest first, and covers it exactly", () => {
    const from = new Date("2021-10-30T10:00:00.000Z");
    const windows = fullBackfillWindows(from, NOW);
    expect(
      windows.map((w) => [w.from.toISOString(), w.to.toISOString()]),
    ).toEqual([
      ["2026-01-01T00:00:00.000Z", NOW.toISOString()],
      ["2025-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
      ["2024-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
      ["2023-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"],
      ["2022-01-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z"],
      [from.toISOString(), "2022-01-01T00:00:00.000Z"],
    ]);
    for (const w of windows) {
      expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(
        366 * 86_400_000,
      );
    }
  });

  it("treats an end on New Year as the end of the year before", () => {
    const windows = fullBackfillWindows(
      new Date("2024-06-01T00:00:00.000Z"),
      new Date("2025-01-01T00:00:00.000Z"),
    );
    expect(windows).toEqual([
      {
        from: new Date("2024-06-01T00:00:00.000Z"),
        to: new Date("2025-01-01T00:00:00.000Z"),
      },
    ]);
  });

  it("is empty for an empty span", () => {
    expect(fullBackfillWindows(NOW, NOW)).toEqual([]);
  });
});

describe("foldUserRollupHistory", () => {
  it("folds every window of the fold window under the given statement limit", async () => {
    const done = await foldUserRollupHistory("user-1", {
      statementTimeoutMs: 1234,
    });
    const expected = fullBackfillWindows(
      new Date(NOW.getTime() - ROLLUP_FOLD_WINDOW_MS),
      NOW,
    );
    expect(mocks.recomputeUserRollups).toHaveBeenCalledTimes(expected.length);
    expected.forEach((w, i) => {
      expect(mocks.recomputeUserRollups).toHaveBeenNthCalledWith(
        i + 1,
        "user-1",
        expect.objectContaining({
          from: w.from,
          to: w.to,
          statementTimeoutMs: 1234,
        }),
      );
    });
    expect(done).toMatchObject({
      rowsUpserted: 10 * expected.length,
      windowsFolded: expected.length,
    });
    expect(done.resumeBefore).toBeUndefined();
  });

  it("stops before the next window and names where the rest begins", async () => {
    const done = await foldUserRollupHistory("user-1", {
      shouldStop: () => mocks.recomputeUserRollups.mock.calls.length >= 1,
    });
    expect(mocks.recomputeUserRollups).toHaveBeenCalledTimes(1);
    expect(done.windowsFolded).toBe(1);
    expect(done.resumeBefore).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("reports a window the fold stopped inside as still to fold", async () => {
    mocks.recomputeUserRollups
      .mockResolvedValueOnce({ rowsUpserted: 5, durationMs: 1 })
      .mockResolvedValueOnce({ rowsUpserted: 2, durationMs: 1, stopped: true });
    const done = await foldUserRollupHistory("user-1", {
      shouldStop: () => false,
    });
    expect(done.windowsFolded).toBe(1);
    expect(done.resumeBefore).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("resumes with only the windows that end at or before `before`", async () => {
    await foldUserRollupHistory("user-1", {
      before: new Date("2025-01-01T00:00:00.000Z"),
    });
    const tos = mocks.recomputeUserRollups.mock.calls.map(
      (call) => (call[1] as { to: Date }).to,
    );
    expect(tos[0]).toEqual(new Date("2025-01-01T00:00:00.000Z"));
    for (const to of tos) {
      expect(to.getTime()).toBeLessThanOrEqual(
        new Date("2025-01-01T00:00:00.000Z").getTime(),
      );
    }
  });
});

describe("handleRollupFullBackfill", () => {
  it("runs every statement of the fold under the full backfill's own limit", async () => {
    await handleRollupFullBackfill([job()]);
    expect(mocks.recomputeUserRollups).toHaveBeenCalled();
    for (const call of mocks.recomputeUserRollups.mock.calls) {
      expect(call[1]).toMatchObject({
        statementTimeoutMs: ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS,
      });
    }
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("hands the years it did not reach to a follow-up and completes", async () => {
    mocks.recomputeUserRollups
      .mockResolvedValueOnce({ rowsUpserted: 5, durationMs: 1 })
      .mockResolvedValueOnce({ rowsUpserted: 0, durationMs: 1, stopped: true });
    const outcome = await handleRollupFullBackfill([job()]);
    expect(outcome.ok).toBe(true);
    expect(mocks.bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload, options] = mocks.bossSend.mock.calls[0];
    expect(queue).toBe(ROLLUP_FULL_BACKFILL_QUEUE);
    expect(payload).toMatchObject({
      userId: "user-1",
      resumeBefore: "2026-01-01T00:00:00.000Z",
    });
    // Not the boot key: the running job still holds that one.
    expect(options.singletonKey).toBe(
      "boot-backfill|user-1|2026-01-01T00:00:00.000Z",
    );
    expect(options.startAfter).toBeGreaterThan(0);
  });

  it("resumes a follow-up where the run before it stopped", async () => {
    await handleRollupFullBackfill([
      job({ resumeBefore: "2024-01-01T00:00:00.000Z" }),
    ]);
    expect(
      (mocks.recomputeUserRollups.mock.calls[0][1] as { to: Date }).to,
    ).toEqual(new Date("2024-01-01T00:00:00.000Z"));
  });

  it("fails a run that could not finish one window, so its retry starts it again", async () => {
    mocks.recomputeUserRollups.mockResolvedValueOnce({
      rowsUpserted: 0,
      durationMs: 1,
      stopped: true,
    });
    await expect(handleRollupFullBackfill([job()])).rejects.toThrow(
      /before it folded a window/,
    );
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("fails the run when the follow-up cannot be queued", async () => {
    mocks.getGlobalBoss.mockReturnValue(null);
    mocks.recomputeUserRollups
      .mockResolvedValueOnce({ rowsUpserted: 5, durationMs: 1 })
      .mockResolvedValueOnce({ rowsUpserted: 0, durationMs: 1, stopped: true });
    await expect(handleRollupFullBackfill([job()])).rejects.toThrow(/no queue/);
  });
});
