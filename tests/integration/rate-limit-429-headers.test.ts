/**
 * Which 429s carry the rate-limit headers, against a real limiter.
 *
 * `POST /api/measurements/batch` is the case that matters most: a first-run
 * Apple Health import reliably trips its 60-per-minute ceiling, and until now
 * the client got a prose sentence and nothing to back off against. The route
 * builds its refusal with a bare `apiError(...)`, so this proves the headers
 * come from `apiHandler` and the limiter's request-scoped verdict rather than
 * from the handler body — which is what makes the other 128 header-less routes
 * covered too.
 *
 * Two more shapes ride along, because the dressing is only honest when the
 * numbers describe the ceiling that actually refused:
 *
 *   - `POST /api/withings/sync` consults two buckets — a 5/minute baseline and
 *     a 1/hour bucket on the expensive full walk. A request the baseline lets
 *     through and the full bucket refuses must report the full bucket.
 *   - `POST /api/medications/extract` clears its limiter and can then be
 *     refused by the daily AI token budget. That 429 belongs to no bucket, so
 *     it must go out with no rate-limit headers at all rather than one naming
 *     a bucket that still has room.
 *
 * Run against a real Postgres because the limiter's window and remainder come
 * out of the atomic upsert, and the budget ledger is a real row too; a mocked
 * verdict would prove the plumbing and not the numbers.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-rate-limit-headers";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "rate-limit-headers",
      email: "rate-limit-headers@example.test",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

function batchRequest(): NextRequest {
  return new NextRequest("http://localhost/api/measurements/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entries: [
        {
          hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
          value: 81.4,
          unit: "kg",
          startDate: "2026-07-20T06:00:00.000Z",
          endDate: "2026-07-20T06:00:00.000Z",
          externalId: `rl-${Math.random().toString(36).slice(2)}`,
        },
      ],
    }),
  });
}

describe("429 rate-limit headers (real Postgres)", () => {
  it("carries Retry-After and the X-RateLimit triple on a route that attaches none", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    // Burn the bucket directly rather than posting sixty batches: the route
    // and the pre-charge share one key, so the next call through the handler
    // is the one that is refused.
    const { checkRateLimit } = await import("@/lib/rate-limit");
    const key = `measurements:batch:${TEST_USER_ID}`;
    for (let i = 0; i < 60; i += 1) {
      await checkRateLimit(key, 60, 60_000);
    }

    const before = Date.now();
    const res = await POST(batchRequest() as never);
    expect(res.status).toBe(429);

    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    const seconds = Number(retryAfter);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);

    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");

    const reset = res.headers.get("X-RateLimit-Reset");
    expect(reset).toBeTruthy();
    const resetAt = Date.parse(reset as string);
    expect(Number.isNaN(resetAt)).toBe(false);
    expect(resetAt).toBeGreaterThan(before);

    // The named delay must actually outlast the window it names.
    expect(before + seconds * 1000).toBeGreaterThanOrEqual(resetAt - 1_000);

    // The body is unchanged — the headers are additive.
    const body = (await res.json()) as { data: null; error: string };
    expect(body.data).toBeNull();
    expect(typeof body.error).toBe("string");
  });

  it("leaves a successful response without them", async () => {
    const { POST } = await import("@/app/api/measurements/batch/route");

    const res = await POST(batchRequest() as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("reports the bucket that refused when a route consults two", async () => {
    const { POST } = await import("@/app/api/withings/sync/route");

    // Burn only the full-sync bucket. The route's baseline 5/60s bucket is
    // untouched, so it passes on the way in and the refusal comes from the
    // 1/hour one — the numbers on the wire have to be that one's.
    const { checkRateLimit } = await import("@/lib/rate-limit");
    await checkRateLimit(`withings-sync-full:${TEST_USER_ID}`, 1, 60 * 60_000);

    const res = await POST(
      new NextRequest("http://localhost/api/withings/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullSync: true }),
      }) as never,
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    // The baseline bucket's window is 60 seconds; the hour-long one cannot be
    // mistaken for it.
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(60);
  });

  it("leaves a 429 the limiter did not produce undressed", async () => {
    // The daily AI budget, not a bucket. The route's own 10-per-5-minutes
    // limiter passes on the way in; dressing this refusal with that verdict
    // would tell the client nine calls are still free and to retry in five
    // minutes, when the budget does not move until UTC midnight.
    await getPrismaClient().user.update({
      where: { id: TEST_USER_ID },
      // A self-hosted local endpoint resolves as the chain's primary, which
      // keeps the request on the user-plan ceiling and off the consent gate.
      data: { aiBaseUrl: "http://127.0.0.1:11434/v1" },
    });
    const { buildDateKey, USER_PLAN_CAP } =
      await import("@/lib/ai/coach/budget");
    await getPrismaClient().coachUsage.create({
      data: {
        userId: TEST_USER_ID,
        dateKey: buildDateKey(),
        totalTokens: USER_PLAN_CAP,
        messageCount: 1,
      },
    });

    const { POST } = await import("@/app/api/medications/extract/route");
    const res = await POST(
      new NextRequest("http://localhost/api/medications/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Mounjaro 5mg weekly Wednesday" }),
      }) as never,
    );

    expect(res.status).toBe(429);
    for (const name of [
      "Retry-After",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ]) {
      expect(res.headers.get(name)).toBeNull();
    }
  });
});
