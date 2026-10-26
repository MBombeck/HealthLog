/**
 * A collection counts toward a backfill's progress only once its resume note
 * is written. The job reads the size of `done` as progress and queues another
 * slice on it, so a key added before a write that failed would let a chain of
 * slices "progress" over the same collection without end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, warnings } = vi.hoisted(() => ({
  prismaMock: {
    googleHealthConnection: { update: vi.fn() },
  },
  warnings: [] as string[],
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => ({ addWarning: (w: string) => warnings.push(w) }),
}));

import {
  recordGoogleHealthBackfillPage,
  runGoogleHealthCollection,
  runWithGoogleHealthBackfillResume,
} from "../sync-core";
import {
  readGoogleHealthBackfillProgress,
  type GoogleHealthBackfillCursor,
} from "../backfill-progress";
import {
  googleHealthSliceBudget,
  runWithGoogleHealthClientOutcome,
  runWithGoogleHealthStop,
} from "@/lib/google-health/budget";

beforeEach(() => {
  vi.clearAllMocks();
  warnings.length = 0;
});

describe("runGoogleHealthCollection under a backfill", () => {
  it("adds a clean collection to done once its note is written", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const done = new Set<string>(["fetchSteps"]);

    await runWithGoogleHealthBackfillResume("u1", done, () =>
      runGoogleHealthCollection("sleep", async () => 3),
    );

    expect([...done]).toEqual(["fetchSteps", "sleep"]);
    expect(prismaMock.googleHealthConnection.update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: {
        backfillProgress: { done: ["fetchSteps", "sleep"], cursors: {} },
      },
    });
  });

  it("counts no progress when the note cannot be written", async () => {
    prismaMock.googleHealthConnection.update.mockRejectedValue(
      new Error("connection reset"),
    );
    const done = new Set<string>(["fetchSteps"]);

    const { result } = await runWithGoogleHealthBackfillResume("u1", done, () =>
      runGoogleHealthCollection("sleep", async () => 3),
    );

    // The rows are in, the collection did not fail, but it is not finished.
    expect(result).toBe(3);
    expect([...done]).toEqual(["fetchSteps"]);
    expect(warnings.some((w) => w.includes("progress write failed"))).toBe(
      true,
    );
  });
});

/**
 * #1220 — a collection read page by page keeps its place inside the
 * collection, not only once it is finished. A heart-rate history of years
 * that one attempt could not finish used to start over from its newest page
 * on every attempt.
 */
describe("the resume edge of a page-by-page collection", () => {
  const at = (iso: string) => new Date(iso);

  it("moves the edge to the oldest sample of each page and persists it", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const cursors = new Map<string, GoogleHealthBackfillCursor>();

    const { advanced } = await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(["sleep"]),
      async () => {
        await recordGoogleHealthBackfillPage("fetchHeartRate", {
          first: at("2026-10-01T12:00:00Z"),
          last: at("2026-10-01T00:00:00Z"),
        });
        await recordGoogleHealthBackfillPage("fetchHeartRate", {
          first: at("2026-09-30T23:59:00Z"),
          last: at("2026-09-30T08:00:00Z"),
        });
      },
      cursors,
    );

    expect(cursors.get("fetchHeartRate")).toEqual({
      at: "2026-09-30T08:00:00.000Z",
      order: "desc",
      pages: 2,
    });
    expect(advanced.get("fetchHeartRate")).toBeNull();
    const last = prismaMock.googleHealthConnection.update.mock.calls.at(
      -1,
    )![0] as { data: { backfillProgress: unknown } };
    expect(last.data.backfillProgress).toEqual({
      done: ["sleep"],
      cursors: {
        fetchHeartRate: {
          at: "2026-09-30T08:00:00.000Z",
          order: "desc",
          pages: 2,
        },
      },
    });
    // And it reads back the way it was written.
    expect(
      readGoogleHealthBackfillProgress(last.data.backfillProgress).cursors.get(
        "fetchHeartRate",
      ),
    ).toEqual(cursors.get("fetchHeartRate"));
  });

  it("follows a walk that runs oldest first", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const cursors = new Map<string, GoogleHealthBackfillCursor>();
    await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      () =>
        recordGoogleHealthBackfillPage("fetchWeight", {
          first: at("2024-01-01T00:00:00Z"),
          last: at("2024-03-01T00:00:00Z"),
        }),
      cursors,
    );
    expect(cursors.get("fetchWeight")).toMatchObject({
      at: "2024-03-01T00:00:00.000Z",
      order: "asc",
    });
  });

  it("does not count a page that moved nothing as progress", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const cursors = new Map<string, GoogleHealthBackfillCursor>([
      [
        "fetchHeartRate",
        { at: "2026-01-01T00:00:00.000Z", order: "desc", pages: 7 },
      ],
    ]);
    const { advanced } = await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      () =>
        // The edge sample itself, read again: no further than before.
        recordGoogleHealthBackfillPage("fetchHeartRate", {
          first: at("2026-01-01T00:00:00Z"),
          last: at("2026-01-01T00:00:00Z"),
        }),
      cursors,
    );
    expect(advanced.size).toBe(0);
    expect(cursors.get("fetchHeartRate")).toMatchObject({
      at: "2026-01-01T00:00:00.000Z",
      pages: 8,
    });
  });

  it("counts no progress when the edge cannot be written", async () => {
    prismaMock.googleHealthConnection.update.mockRejectedValue(
      new Error("connection reset"),
    );
    const cursors = new Map<string, GoogleHealthBackfillCursor>();
    const { advanced } = await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      () =>
        recordGoogleHealthBackfillPage("fetchHeartRate", {
          first: at("2026-10-01T12:00:00Z"),
          last: at("2026-10-01T00:00:00Z"),
        }),
      cursors,
    );
    expect(advanced.size).toBe(0);
    expect(cursors.size).toBe(0);
    expect(warnings.some((w) => w.includes("progress write failed"))).toBe(
      true,
    );
  });

  it("clears a finished collection's edge with the same write that marks it done", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const cursors = new Map<string, GoogleHealthBackfillCursor>([
      [
        "fetchHeartRate",
        { at: "2026-01-01T00:00:00.000Z", order: "desc", pages: 7 },
      ],
    ]);
    const done = new Set<string>();
    await runWithGoogleHealthBackfillResume(
      "u1",
      done,
      () => runGoogleHealthCollection("fetchHeartRate", async () => 1),
      cursors,
    );
    expect([...done]).toEqual(["fetchHeartRate"]);
    expect(cursors.size).toBe(0);
    expect(prismaMock.googleHealthConnection.update).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { backfillProgress: { done: ["fetchHeartRate"], cursors: {} } },
    });
  });

  it("leaves a collection for the next slice once the slice has no budget left", async () => {
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
    const walk = vi.fn(async () => 5);
    const budget = googleHealthSliceBudget(0, 100);
    const { result } = await runWithGoogleHealthClientOutcome(() =>
      runWithGoogleHealthBackfillResume("u1", new Set(), () =>
        runWithGoogleHealthStop(
          () => false,
          () => runGoogleHealthCollection("fetchHeartRate", walk),
          budget,
        ),
      ),
    );
    expect(walk).not.toHaveBeenCalled();
    expect(result.collections).toEqual([
      { key: "fetchHeartRate", status: "deferred", pages: 0, durationMs: 0 },
    ]);
    expect(budget.stopReason).toBe("time_budget");
  });

  it("marks the cycle incomplete when it leaves a collection for later", async () => {
    const { outcome } = await runWithGoogleHealthClientOutcome(() =>
      runWithGoogleHealthBackfillResume("u1", new Set(), () =>
        runWithGoogleHealthStop(
          () => false,
          () => runGoogleHealthCollection("fetchWeight", async () => 0),
          googleHealthSliceBudget(0, 100),
        ),
      ),
    );
    expect(outcome.truncated).toBe(true);
  });
});
