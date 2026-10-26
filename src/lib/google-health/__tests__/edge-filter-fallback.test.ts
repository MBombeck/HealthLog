/**
 * A resumed backfill walk asks Google for the samples up to its edge with an
 * upper bound (`sample_time.physical_time <= "<edge>"`). That bound is valid
 * filter grammar but has not been seen working against the live API. If
 * Google refuses it, every resumed slice would fail on its first request and
 * the backfill would be stuck again.
 *
 *   - A 400 on the first resumed request is answered by reading the
 *     collection again without the bound and passing over the samples beyond
 *     the edge here; the rows handed on are the ones the bound would have
 *     returned.
 *   - The refusal is noted per collection in the backfill's progress, and the
 *     next slice reads without the bound from the start.
 *   - A 400 that is about something else still fails the walk.
 *   - The pages passed over are not charged against the slice's budget, so a
 *     skip deeper than one slice's pages cannot keep a backfill from moving.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock, prismaMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  prismaMock: { googleHealthConnection: { update: vi.fn() } },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});
vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

import {
  GOOGLE_HEALTH_SKIP_MS,
  forEachDataPointPage,
  refusesEdgeFilter,
} from "@/lib/google-health/data-points";
import {
  googleHealthSliceBudget,
  runWithGoogleHealthClientOutcome,
  runWithGoogleHealthStop,
} from "@/lib/google-health/budget";
import {
  GOOGLE_HEALTH_DATA_TYPES,
  type GoogleHealthDataPoint,
} from "@/lib/google-health/mappers";
import { GoogleHealthApiError } from "../response-classifier";
import { GOOGLE_HEALTH_NO_PROGRESS_PAGES } from "../backfill-bounds";
import {
  googleHealthBackfillCursor,
  noteGoogleHealthEdgeFilterUnsupported,
  recordGoogleHealthBackfillPage,
  recordGoogleHealthBackfillResumePoint,
  runWithGoogleHealthBackfillResume,
} from "../sync-core";
import {
  readGoogleHealthBackfillProgress,
  type GoogleHealthBackfillCursor,
} from "../backfill-progress";

const MINUTE = 60_000;
const NOW = Date.parse("2026-01-01T00:00:00Z");
/** Reading `g` is `g` minutes old; the list runs newest first. */
const TOTAL = 40;
const PAGE = 5;
const at = (g: number) => new Date(NOW - g * MINUTE);

const server = { refuseUpperBound: false, requests: [] as string[] };

/**
 * A heart-rate list built from the filter and the page token it is asked
 * with, like the multi-year integration fixture. With `refuseUpperBound`,
 * any filter carrying `<=` is refused the way Google refuses a filter.
 */
function respond(url: string): Response {
  const u = new URL(url);
  const filter = u.searchParams.get("filter") ?? "";
  server.requests.push(filter);
  if (server.refuseUpperBound && filter.includes("<=")) {
    return json(
      {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "Invalid filter expression.",
        },
      },
      400,
    );
  }
  const upTo = /physical_time <= "([^"]+)"/.exec(filter)?.[1];
  const newest = upTo
    ? Math.max(0, Math.ceil((NOW - Date.parse(upTo)) / MINUTE))
    : 0;
  const size = Number(u.searchParams.get("pageSize"));
  const token = Number(u.searchParams.get("pageToken") ?? 0);
  const start = newest + token * size;
  const end = Math.min(TOTAL, start + size);
  const dataPoints = [];
  for (let g = start; g < end; g++) {
    dataPoints.push({
      heartRate: {
        beatsPerMinute: String(60 + g),
        sampleTime: { physicalTime: at(g).toISOString() },
      },
    });
  }
  return json({
    dataPoints,
    ...(end < TOTAL ? { nextPageToken: String(token + 1) } : {}),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Query = Parameters<typeof forEachDataPointPage>[3];

/** Walk and collect what the walk hands on, page by page. */
async function walk(query: Query) {
  const pages: GoogleHealthDataPoint[][] = [];
  const { outcome } = await runWithGoogleHealthClientOutcome(() =>
    forEachDataPointPage(
      GOOGLE_HEALTH_DATA_TYPES.heartRate,
      "token",
      "fetchHeartRate",
      { pageSize: PAGE, ...query },
      (points) => {
        pages.push(points);
      },
    ),
  );
  return { pages, rows: pages.flat(), outcome };
}

beforeEach(() => {
  safeFetchMock.mockReset();
  safeFetchMock.mockImplementation(async (url: string) => respond(url));
  prismaMock.googleHealthConnection.update.mockReset();
  prismaMock.googleHealthConnection.update.mockResolvedValue({});
  server.refuseUpperBound = false;
  server.requests = [];
});

// The edge sits mid-page so the page that crosses it is split.
const EDGE = { at: at(17), order: "desc" as const };

describe("a resumed walk whose edge filter Google refuses", () => {
  it("reads again without the bound and hands on exactly the rows the bound would have", async () => {
    const filtered = await walk({ resumable: true, edge: EDGE });
    expect(server.requests[0]).toContain("<=");
    expect(filtered.rows).toHaveLength(TOTAL - 17);

    server.requests = [];
    server.refuseUpperBound = true;
    const onFilterUnsupported = vi.fn();
    const fallback = await walk({
      resumable: true,
      edge: { ...EDGE, onFilterUnsupported },
    });

    expect(onFilterUnsupported).toHaveBeenCalledTimes(1);
    // One refused request, then the whole walk without any filter.
    expect(server.requests[0]).toContain("<=");
    expect(server.requests.slice(1).every((f) => f === "")).toBe(true);
    expect(fallback.rows).toEqual(filtered.rows);
    expect(fallback.outcome.truncated).toBe(false);
  });

  it("reads without the bound from the start once the collection is known to refuse it", async () => {
    const filtered = await walk({ resumable: true, edge: EDGE });
    server.requests = [];
    server.refuseUpperBound = true;
    const onFilterUnsupported = vi.fn();

    const skipped = await walk({
      resumable: true,
      edge: { ...EDGE, filter: false, onFilterUnsupported },
    });

    expect(server.requests.some((f) => f.includes("<="))).toBe(false);
    expect(onFilterUnsupported).not.toHaveBeenCalled();
    expect(skipped.rows).toEqual(filtered.rows);
  });

  it("follows a walk that runs oldest first", async () => {
    // An ascending walk keeps the samples at or after its edge.
    safeFetchMock.mockImplementation(async () =>
      json({
        dataPoints: [5, 4, 3, 2, 1, 0].map((g) => ({
          heartRate: {
            beatsPerMinute: "60",
            sampleTime: { physicalTime: at(g).toISOString() },
          },
        })),
      }),
    );
    const { rows } = await walk({
      resumable: true,
      edge: { at: at(2), order: "asc", filter: false },
    });
    expect(rows).toHaveLength(3);
  });
});

describe("a 400 that is not about the edge filter", () => {
  it("fails the walk when the first request names something else", async () => {
    safeFetchMock.mockImplementation(async () =>
      json(
        {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Invalid page token.",
          },
        },
        400,
      ),
    );
    const onFilterUnsupported = vi.fn();
    await expect(
      walk({ resumable: true, edge: { ...EDGE, onFilterUnsupported } }),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(onFilterUnsupported).not.toHaveBeenCalled();
  });

  it("fails the walk on a 400 past the first page, where the filter was already taken", async () => {
    let n = 0;
    safeFetchMock.mockImplementation(async (url: string) =>
      ++n === 2
        ? json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400)
        : respond(url),
    );
    const onFilterUnsupported = vi.fn();
    await expect(
      walk({ resumable: true, edge: { ...EDGE, onFilterUnsupported } }),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(onFilterUnsupported).not.toHaveBeenCalled();
  });

  it("fails a walk without an edge on a 400 as before", async () => {
    safeFetchMock.mockImplementation(async () =>
      json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, 400),
    );
    await expect(walk({ resumable: true })).rejects.toBeInstanceOf(
      GoogleHealthApiError,
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("is told apart by what Google says", () => {
    expect(refusesEdgeFilter(undefined)).toBe(true);
    expect(refusesEdgeFilter("INVALID_ARGUMENT: Invalid filter.")).toBe(true);
    expect(refusesEdgeFilter("INVALID_ARGUMENT")).toBe(true);
    expect(refusesEdgeFilter("FAILED_PRECONDITION: filter on field")).toBe(
      true,
    );
    expect(refusesEdgeFilter("INVALID_ARGUMENT: Invalid page token.")).toBe(
      false,
    );
    expect(refusesEdgeFilter("INVALID_ARGUMENT: page_size too large")).toBe(
      false,
    );
    expect(refusesEdgeFilter("FAILED_PRECONDITION: account not set up")).toBe(
      false,
    );
  });
});

describe("passing over the samples beyond the edge inside a slice", () => {
  it("is not charged against the slice's pages, so the slice still writes its share", async () => {
    // The edge is three pages deep; the slice may read two.
    const budget = googleHealthSliceBudget(60_000, 2);
    const { pages, outcome } = await runWithGoogleHealthStop(
      () => false,
      () =>
        walk({
          resumable: true,
          edge: { at: at(15), order: "desc", filter: false },
        }),
      budget,
    );
    expect(pages).toHaveLength(2);
    expect(budget.skippedPages).toBe(3);
    expect(budget.pages).toBe(5);
    expect(budget.stopReason).toBe("page_budget");
    expect(outcome.truncated).toBe(true);
  });

  it("stops on the slice's clock while it is still passing over, and keeps its place", async () => {
    let clock = 0;
    safeFetchMock.mockImplementation(async (url: string) => {
      clock += 10_000;
      return respond(url);
    });
    // Each request takes ten seconds and the slice has fifteen; passing over
    // the first three pages takes thirty. The slice does not run on past its
    // clock for the skip any more: it stops and saves where it got to.
    const budget = googleHealthSliceBudget(15_000, 500, () => clock);
    const onResumePoint = vi.fn();
    const { pages, outcome } = await runWithGoogleHealthStop(
      () => false,
      () =>
        walk({
          resumable: true,
          edge: { at: at(15), order: "desc", filter: false, onResumePoint },
        }),
      budget,
    );
    expect(pages).toHaveLength(0);
    expect(budget.deadline).toBe(15_000);
    expect(budget.stopReason).toBe("time_budget");
    expect(outcome.truncated).toBe(true);
    expect(onResumePoint).toHaveBeenCalledWith({ token: "1", page: 1 });
  });

  it("stops passing over on its own limit inside a long slice, and keeps its place", async () => {
    let clock = 0;
    safeFetchMock.mockImplementation(async (url: string) => {
      clock += 60_000;
      return respond(url);
    });
    // The edge is six pages deep; each request takes a minute, and the skip
    // may run for three of the slice's sixty.
    const budget = googleHealthSliceBudget(3_600_000, 500, () => clock);
    const onResumePoint = vi.fn();
    const { pages, outcome } = await runWithGoogleHealthStop(
      () => false,
      () =>
        walk({
          resumable: true,
          edge: { at: at(30), order: "desc", filter: false, onResumePoint },
        }),
      budget,
    );
    expect(GOOGLE_HEALTH_SKIP_MS).toBe(3 * 60_000);
    expect(pages).toHaveLength(0);
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.truncated).toBe(true);
    // The slice itself is not over: other collections may still run.
    expect(budget.stopReason).toBeNull();
    expect(onResumePoint).toHaveBeenCalledWith({ token: "2", page: 2 });
  });

  it("goes on from the saved place, rereading only its page", async () => {
    const filtered = await walk({
      resumable: true,
      edge: { at: at(30), order: "desc" },
    });
    server.requests = [];
    safeFetchMock.mockClear();
    const tokens: Array<string | null> = [];
    safeFetchMock.mockImplementation(async (url: string) => {
      tokens.push(new URL(url).searchParams.get("pageToken"));
      return respond(url);
    });
    const { rows, outcome } = await walk({
      resumable: true,
      edge: {
        at: at(30),
        order: "desc",
        filter: false,
        resumeFrom: { token: "2", page: 2 },
      },
    });
    expect(rows).toEqual(filtered.rows);
    expect(tokens).toEqual(["2", "3", "4", "5", "6", "7"]);
    expect(outcome.truncated).toBe(false);
  });

  it("saves its place on a rate limit it cannot wait out", async () => {
    let n = 0;
    safeFetchMock.mockImplementation(async (url: string) =>
      ++n === 3
        ? new Response(
            JSON.stringify({
              error: { code: 429, status: "RESOURCE_EXHAUSTED" },
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "retry-after": "3600",
              },
            },
          )
        : respond(url),
    );
    const budget = googleHealthSliceBudget(3_600_000, 500);
    const onResumePoint = vi.fn();
    const { pages, outcome } = await runWithGoogleHealthStop(
      () => false,
      () =>
        walk({
          resumable: true,
          edge: { at: at(30), order: "desc", filter: false, onResumePoint },
        }),
      budget,
    );
    expect(pages).toHaveLength(0);
    expect(budget.stopReason).toBe("rate_limited");
    expect(outcome.truncated).toBe(true);
    expect(onResumePoint).toHaveBeenCalledWith({ token: "1", page: 1 });
  });

  it("reads from the newest page when Google refuses the saved token", async () => {
    let n = 0;
    safeFetchMock.mockImplementation(async (url: string) =>
      ++n === 1
        ? json(
            {
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "Invalid page token.",
              },
            },
            400,
          )
        : respond(url),
    );
    const { rows, outcome } = await walk({
      resumable: true,
      edge: {
        at: at(30),
        order: "desc",
        filter: false,
        resumeFrom: { token: "2", page: 2 },
      },
    });
    expect(rows).toHaveLength(TOTAL - 30);
    expect(outcome.truncated).toBe(false);
  });

  it("reads from the newest page when the saved place no longer reaches the edge", async () => {
    // Page 7 holds only samples older than the edge: the list moved under
    // the token, and going on from it could step over samples nobody wrote.
    const { rows } = await walk({
      resumable: true,
      edge: {
        at: at(30),
        order: "desc",
        filter: false,
        resumeFrom: { token: "7", page: 7 },
      },
    });
    expect(rows.map((p) => p.heartRate)).toEqual(
      Array.from({ length: TOTAL - 30 }, (_, i) => ({
        beatsPerMinute: String(60 + 30 + i),
        sampleTime: { physicalTime: at(30 + i).toISOString() },
      })),
    );
  });

  it("does not charge the pages it passed over against the walk's own ceiling", async () => {
    // Three pages passed over, then a ceiling of two written pages: both are
    // written, not one.
    const { pages, outcome } = await walk({
      resumable: true,
      maxPages: 2,
      edge: { at: at(15), order: "desc", filter: false },
    });
    expect(pages).toHaveLength(2);
    expect(outcome.truncated).toBe(true);
  });

  it("still stops on the job's own budget", async () => {
    let asked = 0;
    const { pages, outcome } = await runWithGoogleHealthStop(
      () => ++asked > 2,
      () =>
        walk({
          resumable: true,
          edge: { at: at(30), order: "desc", filter: false },
        }),
      googleHealthSliceBudget(60_000, 500),
    );
    expect(pages).toHaveLength(0);
    expect(outcome.truncated).toBe(true);
  });

  it("stops passing over once the pages it reads stop reaching further back", async () => {
    // A list that hands out its newest page whatever token it is asked with:
    // passing over it would never reach the edge. There is no page count to
    // run into any more; the walk stops because it gets nowhere.
    safeFetchMock.mockImplementation(async (url: string) => {
      const u = new URL(url);
      u.searchParams.delete("pageToken");
      const res = respond(u.toString());
      const body = (await res.json()) as object;
      return json({ ...body, nextPageToken: "1" });
    });
    const onNoProgress = vi.fn();
    const { pages, outcome } = await walk({
      resumable: true,
      edge: { at: at(30), order: "desc", filter: false },
      onNoProgress,
    });
    expect(pages).toHaveLength(0);
    // The first page reaches somewhere; the twenty after it repeat it.
    expect(safeFetchMock).toHaveBeenCalledTimes(
      1 + GOOGLE_HEALTH_NO_PROGRESS_PAGES,
    );
    expect(outcome.truncated).toBe(true);
    expect(onNoProgress).toHaveBeenCalledTimes(1);
  });

  it("passes over as many pages as it takes while they move toward the edge", async () => {
    // One reading a page, so reaching the edge takes more pages than the
    // no-progress limit and more than any page count a walk once had to fit.
    const { rows, outcome } = await walk({
      resumable: true,
      pageSize: 1,
      edge: { at: at(30), order: "desc", filter: false },
    });
    expect(rows).toHaveLength(TOTAL - 30);
    expect(outcome.truncated).toBe(false);
  });
});

describe("the note that a collection refuses the edge filter", () => {
  /** The progress the last write left in the column. */
  const lastProgress = () =>
    prismaMock.googleHealthConnection.update.mock.calls.at(-1)![0].data
      .backfillProgress as unknown;

  it("is written once Google refuses, kept by later writes, and honoured by the next slice", async () => {
    server.refuseUpperBound = true;
    const cursors = new Map([
      [
        "fetchHeartRate",
        { at: EDGE.at.toISOString(), order: "desc" as const, pages: 4 },
      ],
    ]);

    // Slice one: resumes with the bound, is refused, falls back, writes a page.
    await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      async () => {
        const cursor = googleHealthBackfillCursor("fetchHeartRate")!;
        expect(cursor.edge?.filter).toBe(true);
        await walk({
          resumable: true,
          maxPages: 1,
          edge: {
            ...cursor.edge!,
            onFilterUnsupported: () =>
              noteGoogleHealthEdgeFilterUnsupported("fetchHeartRate"),
          },
        });
        await recordGoogleHealthBackfillPage("fetchHeartRate", {
          first: at(17),
          last: at(19),
        });
      },
      new Map(cursors),
    );
    expect(server.requests.filter((f) => f.includes("<="))).toHaveLength(1);
    const progress = lastProgress();
    expect(progress).toMatchObject({
      edgeFilterUnsupported: ["fetchHeartRate"],
      cursors: { fetchHeartRate: { at: at(19).toISOString() } },
    });

    // Slice two: starts from what slice one left on disk.
    server.requests = [];
    const unsupported =
      readGoogleHealthBackfillProgress(progress).edgeFilterUnsupported;
    await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      async () => {
        const cursor = googleHealthBackfillCursor("fetchHeartRate")!;
        expect(cursor.edge?.filter).toBe(false);
        const { rows } = await walk({ resumable: true, edge: cursor.edge });
        expect(rows).toHaveLength(TOTAL - 19);
      },
      readGoogleHealthBackfillProgress(progress).cursors,
      unsupported,
    );
    expect(server.requests.some((f) => f.includes("<="))).toBe(false);
  });

  it("leaves the progress in its old shape for a backfill that never met the refusal", async () => {
    await runWithGoogleHealthBackfillResume("u1", new Set(), async () => {
      await recordGoogleHealthBackfillPage("fetchHeartRate", {
        first: at(0),
        last: at(4),
      });
    });
    expect(lastProgress()).not.toHaveProperty("edgeFilterUnsupported");
  });

  it("keeps a saved place in the list, counts it as progress only when it moves forward, and hands it to the next slice", async () => {
    server.refuseUpperBound = true;
    const cursor = {
      at: at(30).toISOString(),
      order: "desc" as const,
      pages: 4,
    };
    const run = (
      cursors: Map<string, GoogleHealthBackfillCursor>,
      point: { token: string; page: number },
    ) =>
      runWithGoogleHealthBackfillResume(
        "u1",
        new Set(),
        () => recordGoogleHealthBackfillResumePoint("fetchHeartRate", point),
        cursors,
        new Set(["fetchHeartRate"]),
      );

    const first = await run(new Map([["fetchHeartRate", cursor]]), {
      token: "4",
      page: 4,
    });
    expect(first.advanced.has("fetchHeartRate")).toBe(true);
    const saved = readGoogleHealthBackfillProgress(lastProgress()).cursors;
    expect(saved.get("fetchHeartRate")).toEqual({
      ...cursor,
      resume: { token: "4", page: 4, reached: 4 },
    });

    // The same place again, or one short of it, is not progress.
    const again = await run(new Map(saved), { token: "4", page: 4 });
    expect(again.advanced.size).toBe(0);
    const back = await run(new Map(saved), { token: "2", page: 2 });
    expect(back.advanced.size).toBe(0);
    expect(
      readGoogleHealthBackfillProgress(lastProgress()).cursors.get(
        "fetchHeartRate",
      )?.resume,
    ).toEqual({ token: "2", page: 2, reached: 4 });

    // A page written keeps the place; the next slice is handed it.
    await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      () =>
        recordGoogleHealthBackfillPage("fetchHeartRate", {
          first: at(30),
          last: at(34),
        }),
      new Map(saved),
      new Set(["fetchHeartRate"]),
    );
    const next = readGoogleHealthBackfillProgress(lastProgress()).cursors;
    expect(next.get("fetchHeartRate")?.resume).toEqual(
      saved.get("fetchHeartRate")?.resume,
    );
    await runWithGoogleHealthBackfillResume(
      "u1",
      new Set(),
      async () => {
        expect(
          googleHealthBackfillCursor("fetchHeartRate")?.edge,
        ).toMatchObject({ filter: false, resumeFrom: { token: "4", page: 4 } });
      },
      next,
      new Set(["fetchHeartRate"]),
    );
  });

  it("reads only well-formed keys", () => {
    expect([
      ...readGoogleHealthBackfillProgress({
        edgeFilterUnsupported: ["fetchHeartRate", 3, "x".repeat(65)],
      }).edgeFilterUnsupported,
    ]).toEqual(["fetchHeartRate"]);
    expect(
      readGoogleHealthBackfillProgress(null).edgeFilterUnsupported.size,
    ).toBe(0);
  });
});
