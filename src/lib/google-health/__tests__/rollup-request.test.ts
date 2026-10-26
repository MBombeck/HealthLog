/**
 * Pins the dailyRollUp request contract against the documented v4 shape.
 *
 * The request body mirrors the official example (developers.google.com/health/
 * endpoints): both range bounds are explicit CivilDateTime objects
 * (`{date:{year,month,day}, time:{hours,minutes,seconds,nanos}}`) and the
 * `end` bound is the LAST covered civil day at 23:59:59 — NOT the next day's
 * midnight. The range validator counts the civil days a range touches against
 * the documented cap ("The maximum range for all other data types is 90
 * days"), so an exclusive next-day-midnight end makes a maximal 90-day chunk
 * read as 91 days and 400s — the shape that broke the first live backfill
 * chunk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

import {
  GOOGLE_HEALTH_ROLLUP_FALLBACK_RANGE_DAYS,
  GOOGLE_HEALTH_ROLLUP_RANGE_DAYS,
  buildDailyRollUpBody,
  fetchDailyRollUp,
  type GoogleHealthRollupShape,
} from "../client";
import { extractGoogleApiErrorDetail } from "@/lib/google-health/request";
import { runWithGoogleHealthClientOutcome } from "@/lib/google-health/budget";
import { GOOGLE_HEALTH_DATA_TYPES } from "@/lib/google-health/mappers";
import { GoogleHealthApiError } from "../response-classifier";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

/** Inclusive civil-day count a captured request-body range touches. */
function touchedDays(body: {
  range: {
    start: { date: { year: number; month: number; day: number } };
    end: { date: { year: number; month: number; day: number } };
  };
}): number {
  const s = body.range.start.date;
  const e = body.range.end.date;
  return (
    (Date.UTC(e.year, e.month - 1, e.day) -
      Date.UTC(s.year, s.month - 1, s.day)) /
      (24 * 60 * 60 * 1000) +
    1
  );
}

function capturedBodies(): Array<{
  range: {
    start: { date: { year: number; month: number; day: number } };
    end: { date: { year: number; month: number; day: number } };
  };
}> {
  return safeFetchMock.mock.calls.map((c) =>
    JSON.parse((c[1] as { body: string }).body),
  );
}

beforeEach(() => {
  safeFetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-30T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("buildDailyRollUpBody — documented request shape", () => {
  it("matches the documented single-day example byte-for-byte", () => {
    // Doc example: one civil day rolls up as [day 00:00:00, same day 23:59:59].
    expect(
      buildDailyRollUpBody({
        start: { year: 2026, month: 2, day: 26 },
        end: { year: 2026, month: 2, day: 27 },
      }),
    ).toEqual({
      range: {
        start: {
          date: { year: 2026, month: 2, day: 26 },
          time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
        },
        end: {
          date: { year: 2026, month: 2, day: 26 },
          time: { hours: 23, minutes: 59, seconds: 59, nanos: 0 },
        },
      },
      windowSizeDays: 1,
    });
  });

  it("keeps a maximal 90-day chunk inside the documented 90-day cap", () => {
    const body = buildDailyRollUpBody({
      start: { year: 2026, month: 1, day: 1 },
      end: { year: 2026, month: 4, day: 1 }, // exclusive: 90 civil days
    }) as Parameters<typeof touchedDays>[0];
    // End bound lands on the last covered day (Mar 31), not Apr 1 midnight.
    expect(body.range.end.date).toEqual({ year: 2026, month: 3, day: 31 });
    expect(touchedDays(body)).toBe(GOOGLE_HEALTH_ROLLUP_RANGE_DAYS);
  });

  it("omits pageSize and carries pageToken only when paginating", () => {
    const first = buildDailyRollUpBody({
      start: { year: 2026, month: 6, day: 1 },
      end: { year: 2026, month: 6, day: 8 },
    });
    expect(first).not.toHaveProperty("pageSize");
    expect(first).not.toHaveProperty("pageToken");
    const next = buildDailyRollUpBody(
      {
        start: { year: 2026, month: 6, day: 1 },
        end: { year: 2026, month: 6, day: 8 },
      },
      "tok",
    );
    expect(next.pageToken).toBe("tok");
  });
});

describe("fetchDailyRollUp — chunk walk + conservative fallback", () => {
  it("walks 90-day chunks and reports the standard shape", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(200, {
        rollupDataPoints: [{ steps: { countSum: "100" } }],
      }),
    );
    let shape: GoogleHealthRollupShape | undefined;
    const points = await fetchDailyRollUp(
      GOOGLE_HEALTH_DATA_TYPES.steps,
      "token",
      "fetchSteps",
      {
        start: new Date("2026-01-01T00:00:00Z"),
        onShape: (s) => {
          shape = s;
        },
      },
    );
    expect(shape).toBe("days90");
    // 2026-01-01 → 2026-07-01 (exclusive tomorrow) = 181 days → 3 chunks.
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(points).toHaveLength(3);
    for (const body of capturedBodies()) {
      expect(touchedDays(body)).toBeLessThanOrEqual(
        GOOGLE_HEALTH_ROLLUP_RANGE_DAYS,
      );
    }
  });

  it("re-walks at 14 days when the FIRST request is rejected with a 400", async () => {
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: 400, status: "INVALID_ARGUMENT", message: "bad range" },
      }),
    );
    safeFetchMock.mockResolvedValue(
      jsonResponse(200, { rollupDataPoints: [] }),
    );
    let shape: GoogleHealthRollupShape | undefined;
    await fetchDailyRollUp(
      GOOGLE_HEALTH_DATA_TYPES.steps,
      "token",
      "fetchSteps",
      {
        start: new Date("2026-06-01T00:00:00Z"),
        onShape: (s) => {
          shape = s;
        },
      },
    );
    expect(shape).toBe("days14");
    // First body was a single 30-day chunk; the retry re-chunks at ≤14 days.
    const bodies = capturedBodies();
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies.slice(1)) {
      expect(touchedDays(body)).toBeLessThanOrEqual(
        GOOGLE_HEALTH_ROLLUP_FALLBACK_RANGE_DAYS,
      );
    }
  });

  it("propagates a 400 past the first request instead of re-walking", async () => {
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse(200, { rollupDataPoints: [] }),
    );
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: 400, status: "INVALID_ARGUMENT", message: "nope" },
      }),
    );
    await expect(
      fetchDailyRollUp(GOOGLE_HEALTH_DATA_TYPES.steps, "token", "fetchSteps", {
        start: new Date("2026-01-01T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-400 first-request failure without a fallback walk", async () => {
    // A 403 is neither the fallback's 400 nor a server error worth repeating.
    safeFetchMock.mockResolvedValueOnce(jsonResponse(403, {}));
    await expect(
      fetchDailyRollUp(GOOGLE_HEALTH_DATA_TYPES.steps, "token", "fetchSteps", {
        start: new Date("2026-06-01T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchDailyRollUp — pages within a chunk (walkPages)", () => {
  const oneChunk = { start: new Date("2026-06-20T00:00:00Z") };

  it("follows nextPageToken to the end of a chunk", async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          rollupDataPoints: [{ steps: { countSum: "1" } }],
          nextPageToken: "p2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          rollupDataPoints: [{ steps: { countSum: "2" } }],
          nextPageToken: "",
        }),
      );
    const { result, outcome } = await runWithGoogleHealthClientOutcome(() =>
      fetchDailyRollUp(
        GOOGLE_HEALTH_DATA_TYPES.steps,
        "token",
        "fetchSteps",
        oneChunk,
      ),
    );
    expect(result).toHaveLength(2);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse((safeFetchMock.mock.calls[1]![1] as { body: string }).body)
        .pageToken,
    ).toBe("p2");
    expect(outcome).toMatchObject({ pages: 2, truncated: false });
  });

  it("stops a chunk whose page token comes back again and reports it truncated", async () => {
    safeFetchMock.mockResolvedValue(
      jsonResponse(200, {
        rollupDataPoints: [{ steps: { countSum: "1" } }],
        nextPageToken: "again",
      }),
    );
    const { result, outcome } = await runWithGoogleHealthClientOutcome(() =>
      fetchDailyRollUp(
        GOOGLE_HEALTH_DATA_TYPES.steps,
        "token",
        "fetchSteps",
        oneChunk,
      ),
    );
    // The first page hands out "again", the second hands it out again.
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(outcome).toMatchObject({
      truncated: true,
      reasonCode: "existing_page_limit",
    });
  });

  it("stops a chunk at its page ceiling and reports it truncated", async () => {
    let n = 0;
    safeFetchMock.mockImplementation(async () =>
      jsonResponse(200, { rollupDataPoints: [], nextPageToken: `p${++n}` }),
    );
    const { outcome } = await runWithGoogleHealthClientOutcome(() =>
      fetchDailyRollUp(
        GOOGLE_HEALTH_DATA_TYPES.steps,
        "token",
        "fetchSteps",
        oneChunk,
      ),
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(100);
    expect(outcome).toMatchObject({ pages: 100, truncated: true });
  });
});

describe("extractGoogleApiErrorDetail — AIP-193 field violations", () => {
  it("keeps the plain STATUS: message shape without details", () => {
    expect(
      extractGoogleApiErrorDetail({
        error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid" },
      }),
    ).toBe("INVALID_ARGUMENT: Invalid");
  });

  it("appends fieldViolations as field: description fragments", () => {
    expect(
      extractGoogleApiErrorDetail({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "Invalid argument in request.",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [
                { field: "range", description: "Range too wide." },
              ],
            },
          ],
        },
      }),
    ).toBe(
      "INVALID_ARGUMENT: Invalid argument in request. [range: Range too wide.]",
    );
  });

  it("caps at three violations and tolerates a details-only envelope", () => {
    const detail = extractGoogleApiErrorDetail({
      error: {
        details: [
          {
            fieldViolations: [
              { field: "a", description: "1" },
              { field: "b", description: "2" },
              { field: "c", description: "3" },
              { field: "d", description: "4" },
            ],
          },
        ],
      },
    });
    expect(detail).toBe("[a: 1; b: 2; c: 3]");
  });

  it("redacts tokens and URL queries inside violation descriptions", () => {
    const detail = extractGoogleApiErrorDetail({
      error: {
        status: "INVALID_ARGUMENT",
        details: [
          {
            fieldViolations: [
              {
                field: "range.start",
                description:
                  "Bearer abc123 rejected at https://health.googleapis.com/v4/x?filter=secret",
              },
            ],
          },
        ],
      },
    });
    expect(detail).not.toContain("abc123");
    expect(detail).not.toContain("filter=secret");
  });
});
