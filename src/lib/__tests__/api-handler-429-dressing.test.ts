/**
 * Which 429s `apiHandler` is allowed to dress with rate-limit headers.
 *
 * The wrapper attaches `Retry-After` and the `X-RateLimit` triple to any 429
 * that leaves a handler without them, and it takes the numbers from the
 * request-scoped limiter capture. That is only honest when a limiter actually
 * refused: an AI budget that is spent for the day, an hourly generation quota
 * and a provider-side 429 relayed onward are all 429s no bucket produced, and
 * describing them with a bucket that still has room tells the client to retry
 * into a ceiling that has not moved.
 *
 * So both directions are pinned here: a refusal from the limiter gets the
 * headers, a 429 from anything else gets none.
 */
import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

// --- Mocks must be hoisted before importing the module under test. ---

vi.mock("@/lib/db", () => ({
  prisma: {},
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { apiHandler } from "@/lib/api-handler";
import { captureRateLimitResult } from "@/lib/rate-limit-context";

const RATE_LIMIT_HEADERS = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
] as const;

function refusal(): NextResponse {
  return NextResponse.json({ data: null, error: "Too many" }, { status: 429 });
}

function request(): NextRequest {
  return new NextRequest("http://localhost/api/test", { method: "POST" });
}

describe("apiHandler — 429 header dressing", () => {
  it("dresses a 429 the limiter refused", async () => {
    const resetAt = Date.now() + 30_000;
    const route = apiHandler(async (_request: NextRequest) => {
      captureRateLimitResult({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt,
      });
      return refusal();
    });

    const res = await route(request());

    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(
      new Date(resetAt).toISOString(),
    );
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("leaves a 429 no limiter produced undressed", async () => {
    const route = apiHandler(async (_request: NextRequest) => refusal());

    const res = await route(request());

    expect(res.status).toBe(429);
    for (const name of RATE_LIMIT_HEADERS) {
      expect(res.headers.get(name)).toBeNull();
    }
  });

  it("leaves a 429 undressed when every bucket the handler consulted passed", async () => {
    // The shape of the AI surfaces: a per-minute limiter lets the request
    // through, then a daily budget or an upstream provider refuses it. The
    // window the limiter cleared says nothing about when the budget resets.
    const route = apiHandler(async (_request: NextRequest) => {
      captureRateLimitResult({
        allowed: true,
        limit: 10,
        remaining: 9,
        resetAt: Date.now() + 60_000,
      });
      return refusal();
    });

    const res = await route(request());

    expect(res.status).toBe(429);
    for (const name of RATE_LIMIT_HEADERS) {
      expect(res.headers.get(name)).toBeNull();
    }
  });

  it("reports the bucket that refused when the handler consulted two", async () => {
    const resetAt = Date.now() + 45_000;
    const route = apiHandler(async (_request: NextRequest) => {
      captureRateLimitResult({
        allowed: true,
        limit: 600,
        remaining: 599,
        resetAt: Date.now() + 3_600_000,
      });
      captureRateLimitResult({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetAt,
      });
      return refusal();
    });

    const res = await route(request());

    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Reset")).toBe(
      new Date(resetAt).toISOString(),
    );
  });

  it("keeps the headers a handler attached itself", async () => {
    const route = apiHandler(async (_request: NextRequest) => {
      captureRateLimitResult({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: Date.now() + 30_000,
      });
      return NextResponse.json(
        { data: null, error: "Too many" },
        {
          status: 429,
          headers: { "Retry-After": "900", "X-RateLimit-Limit": "3" },
        },
      );
    });

    const res = await route(request());

    expect(res.headers.get("Retry-After")).toBe("900");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("3");
  });

  it("leaves a non-429 response alone even after a refusal was captured", async () => {
    const route = apiHandler(async (_request: NextRequest) => {
      captureRateLimitResult({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: Date.now() + 30_000,
      });
      return NextResponse.json({ data: { ok: true }, error: null });
    });

    const res = await route(request());

    expect(res.status).toBe(200);
    for (const name of RATE_LIMIT_HEADERS) {
      expect(res.headers.get(name)).toBeNull();
    }
  });
});
