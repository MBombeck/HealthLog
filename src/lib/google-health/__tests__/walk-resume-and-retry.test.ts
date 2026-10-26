/**
 * #1220 — the list walk under a backfill slice.
 *
 *   - A server error or a request that got no answer is repeated a few times
 *     instead of ending a walk of thousands of pages.
 *   - A resumable walk asks only for the samples beyond the edge an earlier
 *     attempt reached.
 *   - Inside a slice, a resumable walk stops on the slice's budget and on a
 *     rate limit it cannot wait out, and reports itself truncated rather than
 *     failing; a walk that is not resumable runs on under the job's limit.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});
vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

import { SafeFetchError } from "@/lib/safe-fetch";
import { forEachDataPointPage } from "@/lib/google-health/data-points";
import { GOOGLE_HEALTH_TRANSIENT_RETRY } from "@/lib/google-health/request";
import {
  googleHealthSliceBudget,
  runWithGoogleHealthClientOutcome,
  runWithGoogleHealthStop,
} from "@/lib/google-health/budget";
import { GOOGLE_HEALTH_DATA_TYPES } from "@/lib/google-health/mappers";
import { GoogleHealthApiError } from "../response-classifier";

function page(n: number, next: boolean, status = 200, headers = {}): Response {
  return new Response(
    JSON.stringify(
      status === 200
        ? {
            dataPoints: [{ n }],
            ...(next ? { nextPageToken: String(n + 1) } : {}),
          }
        : { error: { code: status } },
    ),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

const baseDelay = GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs;
beforeEach(() => {
  safeFetchMock.mockReset();
  GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs = 0;
});
afterAll(() => {
  GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs = baseDelay;
});

const walk = (query: Parameters<typeof forEachDataPointPage>[3] = {}) =>
  runWithGoogleHealthClientOutcome(() =>
    forEachDataPointPage(
      GOOGLE_HEALTH_DATA_TYPES.heartRate,
      "token",
      "fetchHeartRate",
      query,
      () => {},
    ),
  );

describe("a server error or a lost request mid-walk", () => {
  it("is repeated and the walk goes on", async () => {
    safeFetchMock
      .mockResolvedValueOnce(page(0, true))
      .mockResolvedValueOnce(page(0, false, 503))
      .mockRejectedValueOnce(new SafeFetchError("aborted", "timeout"))
      .mockResolvedValueOnce(page(1, false));

    const { outcome } = await walk();

    expect(safeFetchMock).toHaveBeenCalledTimes(4);
    expect(outcome).toMatchObject({ pages: 2, truncated: false });
  });

  it("fails the walk once the retries are spent", async () => {
    safeFetchMock.mockResolvedValue(page(0, false, 500));
    await expect(walk()).rejects.toBeInstanceOf(GoogleHealthApiError);
    expect(safeFetchMock).toHaveBeenCalledTimes(
      GOOGLE_HEALTH_TRANSIENT_RETRY.maxRetries + 1,
    );
  });

  it("does not repeat an error that is not about the server", async () => {
    safeFetchMock.mockRejectedValue(new TypeError("bad request init"));
    await expect(walk()).rejects.toBeInstanceOf(TypeError);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a resumable walk", () => {
  it("asks only for the samples at or beyond the recorded edge", async () => {
    safeFetchMock.mockResolvedValue(page(0, false));
    await walk({
      resumable: true,
      edge: { at: new Date("2025-03-01T08:00:00Z"), order: "desc" },
    });
    const url = new URL(safeFetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get("filter")).toBe(
      'heart_rate.sample_time.physical_time <= "2025-03-01T08:00:00.000Z"',
    );
  });

  it("stops on the slice's page budget and reports itself truncated", async () => {
    safeFetchMock.mockImplementation(async (url: string) =>
      page(Number(new URL(url).searchParams.get("pageToken") ?? 0), true),
    );
    const budget = googleHealthSliceBudget(60_000, 3);
    const { outcome } = await runWithGoogleHealthStop(
      () => false,
      () => walk({ resumable: true }),
      budget,
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
    expect(outcome.truncated).toBe(true);
    expect(budget.stopReason).toBe("page_budget");
  });

  it("starts the slice's clock at the first walk, not when the slice was set up", async () => {
    safeFetchMock.mockResolvedValue(page(0, false));
    let clock = 0;
    const budget = googleHealthSliceBudget(1_000, 500, () => clock);
    // The slice waited ten minutes for the account's lock before walking.
    clock = 600_000;
    const { outcome } = await runWithGoogleHealthStop(
      () => false,
      () => walk({ resumable: true }),
      budget,
    );
    expect(outcome).toMatchObject({ pages: 1, truncated: false });
    expect(budget.deadline).toBe(601_000);
  });

  it("ends the slice on a rate limit it cannot wait out, without failing", async () => {
    safeFetchMock
      .mockResolvedValueOnce(page(0, true))
      .mockResolvedValueOnce(page(1, true, 429, { "retry-after": "3600" }));
    const budget = googleHealthSliceBudget(60_000, 500);
    const { outcome } = await runWithGoogleHealthStop(
      () => false,
      () => walk({ resumable: true }),
      budget,
    );
    expect(outcome).toMatchObject({ pages: 1, truncated: true });
    expect(budget.stopReason).toBe("rate_limited");
  });

  it("gives way to a waiting heavy job after its first page, keeping its place", async () => {
    safeFetchMock.mockImplementation(async (url: string) =>
      page(Number(new URL(url).searchParams.get("pageToken") ?? 0), true),
    );
    const budget = googleHealthSliceBudget(60_000, 500, Date.now, () => true);
    const { outcome } = await runWithGoogleHealthStop(
      () => false,
      () => walk({ resumable: true }),
      budget,
    );
    // Never before a page is on disk: a slice that ended empty would fail.
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.truncated).toBe(true);
    expect(budget.stopReason).toBe("lane_wanted");
  });

  it("still fails on a rate limit outside a slice", async () => {
    safeFetchMock.mockResolvedValue(
      page(0, true, 429, { "retry-after": "3600" }),
    );
    await expect(walk({ resumable: true })).rejects.toBeInstanceOf(
      GoogleHealthApiError,
    );
  });
});

describe("a walk that is not resumable", () => {
  it("runs past the slice's budget to its end", async () => {
    safeFetchMock.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get("pageToken") ?? 0);
      return page(n, n < 5);
    });
    const budget = googleHealthSliceBudget(0, 1);
    const { outcome } = await runWithGoogleHealthStop(
      () => false,
      () => walk(),
      budget,
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(6);
    expect(outcome.truncated).toBe(false);
  });

  it("does not give way part-way, since it would start over", async () => {
    safeFetchMock.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get("pageToken") ?? 0);
      return page(n, n < 3);
    });
    const { outcome } = await runWithGoogleHealthStop(
      () => false,
      () => walk(),
      googleHealthSliceBudget(60_000, 500, Date.now, () => true),
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(4);
    expect(outcome.truncated).toBe(false);
  });

  it("still stops on the job's own budget", async () => {
    safeFetchMock.mockImplementation(async () => page(0, true));
    let asked = 0;
    const { outcome } = await runWithGoogleHealthStop(
      () => ++asked > 2,
      () => walk(),
      googleHealthSliceBudget(60_000, 500),
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.truncated).toBe(true);
  });
});
