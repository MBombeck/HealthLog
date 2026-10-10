/**
 * #1194 — how one Google Health data request answers a 429 and a 401, and
 * which of two readings sharing a natural key a write keeps (#1195).
 *
 * A 429 is Google's per-user, per-minute quota. It is waited out and the
 * request sent again: the delay Google asks for when it asks (`Retry-After`,
 * or a `RetryInfo` detail in the body), otherwise a doubling backoff, and a
 * request still throttled after the last retry fails as the transient it is.
 * Never as a reauth.
 *
 * A 401 with a token source is answered by asking the source once for a
 * fresh token and repeating the request; the token had expired, not the
 * grant. A second 401, or a 401 on a fixed token, still fails as a reauth,
 * because then it is one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

import {
  GOOGLE_HEALTH_DATA_TYPES,
  GOOGLE_HEALTH_RATE_LIMIT,
  fetchDataPoints,
  googleHealthRetryDelayMs,
} from "../client";
import { collapseNaturalKeyTwins } from "../sync-core";
import { GoogleHealthApiError } from "../response-classifier";

function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const throttled = () =>
  response(429, {
    error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota" },
  });

beforeEach(() => {
  safeFetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a 429 from a data read", () => {
  it("waits with a doubling backoff and repeats the request", async () => {
    vi.useFakeTimers();
    safeFetchMock
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(throttled())
      .mockResolvedValueOnce(response(200, { dataPoints: [{ a: 1 }] }));

    const read = fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.weight,
      "token",
      "fetchWeight",
    );
    await vi.advanceTimersByTimeAsync(GOOGLE_HEALTH_RATE_LIMIT.baseDelayMs);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(GOOGLE_HEALTH_RATE_LIMIT.baseDelayMs * 2);

    await expect(read).resolves.toEqual([{ a: 1 }]);
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails as transient, never as a reauth, once the retries run out", async () => {
    vi.useFakeTimers();
    safeFetchMock.mockImplementation(async () => throttled());

    const read = fetchDataPoints(
      GOOGLE_HEALTH_DATA_TYPES.weight,
      "token",
      "fetchWeight",
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const err = await read;

    expect(err).toBeInstanceOf(GoogleHealthApiError);
    expect((err as GoogleHealthApiError).classification).toBe("transient");
    expect(safeFetchMock).toHaveBeenCalledTimes(
      GOOGLE_HEALTH_RATE_LIMIT.maxRetries + 1,
    );
  });

  it("does not sleep out a delay longer than the cap", async () => {
    safeFetchMock.mockResolvedValue(
      response(429, {}, { "retry-after": "3600" }),
    );

    await expect(
      fetchDataPoints(GOOGLE_HEALTH_DATA_TYPES.weight, "token", "fetchWeight"),
    ).rejects.toMatchObject({ classification: "transient" });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the delay Google asks for from the header or the body", () => {
    const now = Date.parse("2026-10-10T12:00:00.000Z");
    expect(
      googleHealthRetryDelayMs(response(429, {}, { "retry-after": "7" }), {}),
    ).toBe(7000);
    expect(
      googleHealthRetryDelayMs(
        response(429, {}, { "retry-after": "Sat, 10 Oct 2026 12:00:30 GMT" }),
        {},
        now,
      ),
    ).toBe(30_000);
    expect(
      googleHealthRetryDelayMs(response(429), {
        error: {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "12.5s",
            },
          ],
        },
      }),
    ).toBe(12_500);
    expect(googleHealthRetryDelayMs(response(429), {})).toBeUndefined();
  });
});

describe("a 401 from a data read", () => {
  it("asks a token source once for a fresh token and repeats the request", async () => {
    safeFetchMock
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200, { dataPoints: [{ a: 1 }] }));
    const source = vi.fn(async ({ forceRefresh }: { forceRefresh: boolean }) =>
      forceRefresh ? "fresh" : "stale",
    );

    await expect(
      fetchDataPoints(GOOGLE_HEALTH_DATA_TYPES.weight, source, "fetchWeight"),
    ).resolves.toEqual([{ a: 1 }]);
    expect(source.mock.calls.map(([o]) => o.forceRefresh)).toEqual([
      false,
      true,
    ]);
    const auth = (n: number) =>
      new Headers((safeFetchMock.mock.calls[n]![1] as RequestInit).headers).get(
        "authorization",
      );
    expect(auth(0)).toBe("Bearer stale");
    expect(auth(1)).toBe("Bearer fresh");
  });

  it("is a reauth when the fresh token is refused too", async () => {
    safeFetchMock.mockResolvedValue(response(401));

    await expect(
      fetchDataPoints(
        GOOGLE_HEALTH_DATA_TYPES.weight,
        async () => "token",
        "fetchWeight",
      ),
    ).rejects.toMatchObject({ classification: "reauth_required" });
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it("is a reauth at once on a fixed token", async () => {
    safeFetchMock.mockResolvedValue(response(401));

    await expect(
      fetchDataPoints(GOOGLE_HEALTH_DATA_TYPES.weight, "token", "fetchWeight"),
    ).rejects.toMatchObject({ classification: "reauth_required" });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("collapseNaturalKeyTwins (#1195)", () => {
  const end = new Date("2026-10-09T02:00:00.000Z");
  const reading = (externalId: string, value: number, stage = "CORE") => ({
    type: "SLEEP_DURATION",
    value,
    unit: "minutes",
    measuredAt: end,
    externalId,
    sleepStage: stage as "CORE" | "DEEP",
  });

  it("keeps the longer of two segments sharing a stage and an end", () => {
    const { kept, dropped } = collapseNaturalKeyTwins([
      reading("s:sleep:00:30", 90),
      reading("s:sleep:00:00", 120),
      reading("s:sleep:01:00", 60, "DEEP"),
    ]);
    expect(kept.map((r) => r.externalId)).toEqual([
      "s:sleep:00:00",
      "s:sleep:01:00",
    ]);
    expect(dropped).toBe(1);
  });

  it("picks the same reading whatever order the pair arrives in", () => {
    const a = reading("phone:sleep:00:00", 60);
    const b = reading("watch:sleep:00:00", 60);
    expect(collapseNaturalKeyTwins([a, b]).kept).toEqual([a]);
    expect(collapseNaturalKeyTwins([b, a]).kept).toEqual([a]);
  });
});
