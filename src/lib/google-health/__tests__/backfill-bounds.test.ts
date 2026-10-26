/**
 * #1220 — a Google Health backfill is bounded by whether it gets anywhere and
 * by a horizon in years, not by a count of the pages it has read.
 *
 * The count (ten thousand pages per data type, across every slice) ran out
 * about two and a half years into a heart-rate history recorded every few
 * seconds, never reset, and left the backfill stopping at the same place on
 * every slice without ever being marked complete.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, safeFetchMock, annotateMock } = vi.hoisted(() => ({
  prismaMock: { googleHealthConnection: { update: vi.fn() } },
  safeFetchMock: vi.fn(),
  annotateMock: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch: safeFetchMock,
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: annotateMock,
  getEvent: () => null,
}));

import {
  GOOGLE_HEALTH_NO_PROGRESS_PAGES,
  googleHealthBackfillHorizon,
  googleHealthBackfillHorizonYears,
  googleHealthWalkProgress,
  noteGoogleHealthWalkPage,
  type GoogleHealthBackfillEnd,
} from "../backfill-bounds";
import {
  recordGoogleHealthBackfillEnd,
  runGoogleHealthCollection,
  runWithGoogleHealthBackfillResume,
} from "../sync-core";
import {
  googleHealthBackfillEndedList,
  googleHealthBackfillProgressAfterCompletion,
  googleHealthBackfillRetryPending,
  readGoogleHealthBackfillProgress,
} from "../backfill-progress";
import { forEachDataPointPage } from "@/lib/google-health/data-points";
import {
  noteGoogleHealthDeferred,
  runWithGoogleHealthClientOutcome,
} from "@/lib/google-health/budget";
import { GOOGLE_HEALTH_DATA_TYPES } from "@/lib/google-health/mappers";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-17T12:00:00Z");

/** A newest-first page of `size` readings, `offset` minutes back from T0. */
function descPage(offset: number, size = 1000): number[] {
  return Array.from({ length: size }, (_, i) => T0 - (offset + i) * MINUTE);
}

describe("the progress guard", () => {
  it("never stops a walk that reaches further back on every page", () => {
    // Fifty thousand pages: five times the old page count, still moving.
    const progress = googleHealthWalkProgress();
    for (let page = 0; page < 50_000; page++) {
      expect(noteGoogleHealthWalkPage(progress, descPage(page * 1000, 2))).toBe(
        false,
      );
    }
    expect(progress.stalled).toBe(0);
    expect(progress.order).toBe("desc");
  });

  it("stops a walk that keeps getting the same page", () => {
    const progress = googleHealthWalkProgress();
    const page = descPage(0, 50);
    expect(noteGoogleHealthWalkPage(progress, page)).toBe(false);
    for (let i = 1; i < GOOGLE_HEALTH_NO_PROGRESS_PAGES; i++) {
      expect(noteGoogleHealthWalkPage(progress, page)).toBe(false);
    }
    expect(noteGoogleHealthWalkPage(progress, page)).toBe(true);
  });

  it("starts over counting once a page reaches further again", () => {
    const progress = googleHealthWalkProgress();
    noteGoogleHealthWalkPage(progress, descPage(0, 10));
    for (let i = 0; i < GOOGLE_HEALTH_NO_PROGRESS_PAGES - 1; i++) {
      noteGoogleHealthWalkPage(progress, descPage(0, 10));
    }
    expect(noteGoogleHealthWalkPage(progress, descPage(10, 10))).toBe(false);
    expect(progress.stalled).toBe(0);
  });

  it("counts a cycle of pages it has already seen as no progress", () => {
    const progress = googleHealthWalkProgress();
    const pages = [descPage(0, 5), descPage(5, 5), descPage(10, 5)];
    for (const page of pages) noteGoogleHealthWalkPage(progress, page);
    let stopped = false;
    for (let i = 0; i < GOOGLE_HEALTH_NO_PROGRESS_PAGES && !stopped; i++) {
      stopped = noteGoogleHealthWalkPage(progress, pages[i % 3]!);
    }
    expect(stopped).toBe(true);
  });

  it("measures a walk resumed at an edge from the edge", () => {
    // Pages newer than the edge are what the walk already wrote.
    const edge = new Date(T0 - 5000 * MINUTE);
    const progress = googleHealthWalkProgress({ at: edge, order: "desc" });
    for (let i = 0; i < GOOGLE_HEALTH_NO_PROGRESS_PAGES - 1; i++) {
      expect(noteGoogleHealthWalkPage(progress, descPage(i * 10, 10))).toBe(
        false,
      );
    }
    expect(noteGoogleHealthWalkPage(progress, descPage(500, 10))).toBe(true);
  });

  it("counts a page without a readable time as no progress", () => {
    const progress = googleHealthWalkProgress();
    noteGoogleHealthWalkPage(progress, descPage(0, 3));
    for (let i = 0; i < GOOGLE_HEALTH_NO_PROGRESS_PAGES - 1; i++) {
      noteGoogleHealthWalkPage(progress, [null, null]);
    }
    expect(noteGoogleHealthWalkPage(progress, [])).toBe(true);
  });

  it("follows an oldest-first walk forward", () => {
    const progress = googleHealthWalkProgress();
    for (let page = 0; page < 100; page++) {
      const asc = Array.from(
        { length: 10 },
        (_, i) => T0 + (page * 10 + i) * MINUTE,
      );
      expect(noteGoogleHealthWalkPage(progress, asc)).toBe(false);
    }
    expect(progress.order).toBe("asc");
  });
});

describe("the walk under the progress guard", () => {
  const respond = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const reading = (t: number) => ({
    heartRate: {
      beatsPerMinute: "60",
      sampleTime: { physicalTime: new Date(t).toISOString() },
    },
  });
  const walk = async (onPage: (n: number) => void = () => {}) => {
    const onNoProgress = vi.fn();
    const { outcome } = await runWithGoogleHealthClientOutcome(() =>
      forEachDataPointPage(
        GOOGLE_HEALTH_DATA_TYPES.heartRate,
        "token",
        "fetchHeartRate",
        { onNoProgress, maxPages: 10_000 },
        (points) => onPage(points.length),
      ),
    );
    return { outcome, onNoProgress };
  };

  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  it("is not stopped by a long history that keeps moving", async () => {
    const pages = 3 * GOOGLE_HEALTH_NO_PROGRESS_PAGES;
    safeFetchMock.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get("pageToken") ?? 0);
      return respond({
        dataPoints: [reading(T0 - n * MINUTE)],
        ...(n + 1 < pages ? { nextPageToken: String(n + 1) } : {}),
      });
    });
    const { outcome, onNoProgress } = await walk();
    expect(safeFetchMock).toHaveBeenCalledTimes(pages);
    expect(outcome.truncated).toBe(false);
    expect(onNoProgress).not.toHaveBeenCalled();
  });

  it("stops a walk that Google keeps answering with the same page", async () => {
    safeFetchMock.mockImplementation(async () =>
      respond({ dataPoints: [reading(T0)], nextPageToken: "again" }),
    );
    const written: number[] = [];
    const { outcome, onNoProgress } = await walk((n) => written.push(n));
    expect(safeFetchMock).toHaveBeenCalledTimes(
      1 + GOOGLE_HEALTH_NO_PROGRESS_PAGES,
    );
    // The page that tipped it over is not handed on.
    expect(written).toHaveLength(GOOGLE_HEALTH_NO_PROGRESS_PAGES);
    expect(outcome.truncated).toBe(true);
    expect(onNoProgress).toHaveBeenCalledTimes(1);
  });

  it("ends as complete, not truncated, when the caller says it has read enough", async () => {
    safeFetchMock.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get("pageToken") ?? 0);
      return respond({
        dataPoints: [reading(T0 - n * MINUTE)],
        nextPageToken: String(n + 1),
      });
    });
    let pages = 0;
    const { outcome } = await runWithGoogleHealthClientOutcome(() =>
      forEachDataPointPage(
        GOOGLE_HEALTH_DATA_TYPES.heartRate,
        "token",
        "fetchHeartRate",
        {},
        () => (++pages === 3 ? "end" : undefined),
      ),
    );
    expect(pages).toBe(3);
    expect(outcome.truncated).toBe(false);
  });
});

describe("the backfill horizon", () => {
  const saved = process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS;
  afterEach(() => {
    if (saved === undefined)
      delete process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS;
    else process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS = saved;
  });

  it("reads back twenty years unless the operator says otherwise", () => {
    delete process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS;
    expect(googleHealthBackfillHorizonYears()).toBe(20);
    expect(
      googleHealthBackfillHorizon(
        new Date("2026-10-17T12:00:00Z"),
      ).toISOString(),
    ).toBe("2006-10-17T12:00:00.000Z");
  });

  it("takes a whole number of years from 1 to 100", () => {
    process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS = "5";
    expect(googleHealthBackfillHorizonYears()).toBe(5);
    expect(
      googleHealthBackfillHorizon(
        new Date("2026-10-17T12:00:00Z"),
      ).toISOString(),
    ).toBe("2021-10-17T12:00:00.000Z");
    for (const bad of ["0", "101", "2.5", "-3", "ten", " "]) {
      process.env.GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS = bad;
      expect(googleHealthBackfillHorizonYears()).toBe(20);
    }
  });
});

describe("a collection ended short", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.googleHealthConnection.update.mockResolvedValue({});
  });

  const HOUR = 3_600_000;
  const END = {
    type: "PULSE" as const,
    at: "2024-05-11T00:00:00.000Z",
    reason: "no_progress" as const,
  };
  const HORIZON_END = {
    type: "WEIGHT" as const,
    at: "2006-10-17T12:00:00.000Z",
    reason: "horizon" as const,
  };
  /** An end without progress `attempts` deep, the last `hoursAgo` back. */
  const parked = (attempts: number, hoursAgo: number) => ({
    ...END,
    attempts,
    endedAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
  });

  /** One slice walking heart rate with `walk`, from `ended`. */
  async function slice(
    walk: () => Promise<number>,
    ended = new Map<string, GoogleHealthBackfillEnd>(),
    done = new Set<string>(),
  ) {
    return runWithGoogleHealthClientOutcome(() =>
      runWithGoogleHealthBackfillResume(
        "u1",
        done,
        () => runGoogleHealthCollection("fetchHeartRate", walk),
        new Map(),
        new Set(),
        ended,
      ),
    ).then((r) => r.result);
  }

  /** A walk stopped for no progress: truncated, and the end noted. */
  const stalls = vi.fn(async () => {
    noteGoogleHealthDeferred();
    await recordGoogleHealthBackfillEnd("fetchHeartRate", END);
    return 0;
  });

  it("parks a first end without progress: not finished, edge kept, not published", async () => {
    const done = new Set<string>();
    const { ended, collections } = await slice(stalls, new Map(), done);
    expect(collections).toEqual([
      expect.objectContaining({ key: "fetchHeartRate", status: "stopped" }),
    ]);
    expect(done.has("fetchHeartRate")).toBe(false);
    const note = ended.get("fetchHeartRate")!;
    expect(note).toMatchObject({ ...END, attempts: 1 });
    expect(Date.now() - Date.parse(note.endedAt!)).toBeLessThan(60_000);
    const written = prismaMock.googleHealthConnection.update.mock.calls.at(
      -1,
    )![0].data.backfillProgress as unknown;
    expect(
      readGoogleHealthBackfillProgress(written).ended.get("fetchHeartRate"),
    ).toEqual(note);
    // Waiting for another try is not where the history ends.
    expect(googleHealthBackfillEndedList(written)).toEqual([]);
    expect(googleHealthBackfillProgressAfterCompletion(ended)).toBeNull();
  });

  it("annotates an end in one fixed shape", async () => {
    await slice(stalls, new Map([["fetchWeight", HORIZON_END]]));
    const notes = annotateMock.mock.calls
      .map(([fields]) => fields.meta?.["googleHealth.backfill.ended"])
      .filter(Boolean);
    expect(notes).toEqual([
      {
        collection: "fetchHeartRate",
        type: "PULSE",
        reason: "no_progress",
        final: false,
        endedCount: 2,
        finalCount: 1,
        types: ["PULSE", "WEIGHT"],
      },
    ]);
  });

  it("is not walked again before its day is up", async () => {
    const walk = vi.fn(async () => 1);
    const { skipped } = await slice(
      walk,
      new Map<string, GoogleHealthBackfillEnd>([
        ["fetchHeartRate", parked(1, 23)],
      ]),
    );
    expect(walk).not.toHaveBeenCalled();
    expect(skipped).toEqual(["fetchHeartRate"]);
  });

  it("is walked again once its day is up, and a second end without progress is final", async () => {
    const done = new Set<string>();
    const { ended, collections } = await slice(
      stalls,
      new Map<string, GoogleHealthBackfillEnd>([
        ["fetchHeartRate", parked(1, 25)],
      ]),
      done,
    );
    expect(stalls).toHaveBeenCalledTimes(1);
    expect(collections).toEqual([
      expect.objectContaining({ key: "fetchHeartRate", status: "done" }),
    ]);
    expect(done.has("fetchHeartRate")).toBe(true);
    expect(ended.get("fetchHeartRate")).toMatchObject({ ...END, attempts: 2 });
    expect(
      googleHealthBackfillProgressAfterCompletion(ended)!.ended.fetchHeartRate,
    ).toMatchObject({ ...END, attempts: 2 });
  });

  it("starts the count over when the retry got further back before it stalled again", async () => {
    const further = { ...END, at: "2023-01-02T00:00:00.000Z" };
    const done = new Set<string>();
    const { ended, collections } = await slice(
      async () => {
        noteGoogleHealthDeferred();
        await recordGoogleHealthBackfillEnd("fetchHeartRate", further);
        return 4;
      },
      new Map<string, GoogleHealthBackfillEnd>([
        ["fetchHeartRate", parked(1, 25)],
      ]),
      done,
    );
    // Progress, then a new stall: parked again, not final.
    expect(ended.get("fetchHeartRate")).toMatchObject({
      ...further,
      attempts: 1,
    });
    expect(done.has("fetchHeartRate")).toBe(false);
    expect(collections).toEqual([
      expect.objectContaining({ key: "fetchHeartRate", status: "stopped" }),
    ]);
  });

  it("goes back to an ordinary walk when the second attempt gets somewhere", async () => {
    const { ended, collections } = await slice(
      async () => {
        // Moved on, then ran out of slice: no end this time.
        noteGoogleHealthDeferred();
        return 5;
      },
      new Map<string, GoogleHealthBackfillEnd>([
        ["fetchHeartRate", parked(1, 25)],
      ]),
    );
    expect(collections).toEqual([
      expect.objectContaining({ key: "fetchHeartRate", status: "stopped" }),
    ]);
    expect(ended.has("fetchHeartRate")).toBe(false);
  });

  it("is skipped for good once final, and so is the horizon", async () => {
    const walk = vi.fn(async () => 1);
    const { skipped } = await slice(
      walk,
      new Map<string, GoogleHealthBackfillEnd>([
        ["fetchHeartRate", parked(2, 100)],
      ]),
    );
    expect(walk).not.toHaveBeenCalled();
    expect(skipped).toEqual(["fetchHeartRate"]);

    const atHorizon = await slice(
      walk,
      new Map<string, GoogleHealthBackfillEnd>([
        ["fetchHeartRate", { ...HORIZON_END, type: "PULSE" as const }],
      ]),
    );
    expect(walk).not.toHaveBeenCalled();
    expect(atHorizon.skipped).toEqual(["fetchHeartRate"]);
  });

  it("finishes the collection at once at the horizon", async () => {
    const done = new Set<string>();
    const { collections } = await slice(
      async () => {
        await recordGoogleHealthBackfillEnd("fetchHeartRate", {
          ...HORIZON_END,
          type: "PULSE",
        });
        return 3;
      },
      new Map(),
      done,
    );
    expect(collections).toEqual([
      expect.objectContaining({ key: "fetchHeartRate", status: "done" }),
    ]);
    expect(done.has("fetchHeartRate")).toBe(true);
  });

  it("outlives the completion stamp when final, and nothing else does", () => {
    expect(googleHealthBackfillProgressAfterCompletion(new Map())).toBeNull();
    expect(
      googleHealthBackfillProgressAfterCompletion(
        new Map<string, GoogleHealthBackfillEnd>([
          ["fetchWeight", HORIZON_END],
          ["fetchHeartRate", parked(1, 1)],
        ]),
      ),
    ).toEqual({ ended: { fetchWeight: HORIZON_END } });
  });

  it("names the earliest retry among the parked ones", () => {
    const early = parked(1, 20);
    expect(
      googleHealthBackfillRetryPending(
        new Map<string, GoogleHealthBackfillEnd>([
          ["fetchWeight", HORIZON_END],
          ["fetchHeartRate", early],
          ["fetchHrv", parked(1, 2)],
          ["fetchSpo2", parked(2, 30)],
        ]),
      ),
    ).toEqual({
      keys: ["fetchHeartRate", "fetchHrv"],
      dueAt: Date.parse(early.endedAt) + 24 * HOUR,
    });
    expect(
      googleHealthBackfillRetryPending(
        new Map<string, GoogleHealthBackfillEnd>([
          ["fetchWeight", HORIZON_END],
        ]),
      ),
    ).toBeNull();
  });

  it("is published per type when final, and a malformed note is dropped", () => {
    expect(
      googleHealthBackfillEndedList({
        ended: {
          fetchHeartRate: parked(2, 30),
          fetchRhr: parked(1, 1),
          fetchWeight: HORIZON_END,
          fetchBodyFat: { type: "BODY_FAT", at: "nope", reason: "horizon" },
          fetchSpo2: { type: "NOT_A_TYPE", at: END.at, reason: "horizon" },
          fetchHrv: { type: "PULSE", at: END.at, reason: "because" },
        },
      }),
    ).toEqual([
      { type: "PULSE", endsAt: END.at, reason: "no_progress" },
      {
        type: "WEIGHT",
        endsAt: "2006-10-17T12:00:00.000Z",
        reason: "horizon",
      },
    ]);
    expect(googleHealthBackfillEndedList(null)).toEqual([]);
  });
});
