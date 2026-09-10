/**
 * The rate-limit response headers and the request-scoped verdict capture.
 *
 * The headers are what a refused client backs off against, so the shape is
 * pinned here rather than left to whichever route happens to be exercised:
 * `Retry-After` in whole seconds rounding UP, the cap and the remainder as
 * plain integers, and the reset instant in the ISO form it has always carried.
 *
 * The capture half is what lets `apiHandler` dress a 429 that a handler built
 * without headers. It keeps refusals and nothing else: a handler that clears
 * one bucket and is refused by the next reports the bucket that refused it,
 * and a request every bucket let through reports nothing at all, because a
 * 429 it ends up answering came from some other ceiling.
 */
import { describe, expect, it } from "vitest";

import {
  capturedRateLimit,
  captureRateLimitResult,
  rateLimitResponseHeaders,
  runWithRateLimitCapture,
} from "@/lib/rate-limit-context";

describe("rateLimitResponseHeaders", () => {
  it("emits Retry-After, the cap, the remainder and the reset instant", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const headers = rateLimitResponseHeaders(
      { limit: 60, remaining: 0, resetAt: now + 30_000 },
      now,
    );

    expect(headers).toEqual({
      "Retry-After": "30",
      "X-RateLimit-Limit": "60",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": new Date(now + 30_000).toISOString(),
    });
  });

  it("rounds Retry-After up so the named delay outlasts the window", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const headers = rateLimitResponseHeaders(
      { limit: 10, remaining: 0, resetAt: now + 1 },
      now,
    );
    // One millisecond left still means "wait a second", never "retry now" —
    // a floored zero would send the client straight back into the same window.
    expect(headers["Retry-After"]).toBe("1");
  });

  it("never names a delay in the past", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const headers = rateLimitResponseHeaders(
      { limit: 10, remaining: 0, resetAt: now - 5_000 },
      now,
    );
    expect(headers["Retry-After"]).toBe("0");
  });

  it("keeps X-RateLimit-Reset in the ISO form already on the wire", () => {
    const resetAt = Date.UTC(2026, 4, 17, 8, 30, 0);
    const headers = rateLimitResponseHeaders({
      limit: 120,
      remaining: 7,
      resetAt,
    });
    expect(headers["X-RateLimit-Reset"]).toBe("2026-05-17T08:30:00.000Z");
  });
});

describe("request-scoped rate-limit capture", () => {
  it("reads null outside a request scope", () => {
    captureRateLimitResult({
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAt: Date.now(),
    });
    expect(capturedRateLimit()).toBeNull();
  });

  it("reports nothing when every bucket passed, so a 429 from elsewhere stays undressed", () => {
    runWithRateLimitCapture(() => {
      captureRateLimitResult({
        allowed: true,
        limit: 5,
        remaining: 4,
        resetAt: 1_000,
      });
      captureRateLimitResult({
        allowed: true,
        limit: 9,
        remaining: 8,
        resetAt: 2_000,
      });
      // Passing every bucket is exactly the state in which a 429 did not come
      // from the limiter. Rendering the passing verdict would put
      // `X-RateLimit-Remaining: 8` beside a refusal and a delay measured
      // against a window that has nothing to do with it.
      expect(capturedRateLimit()).toBeNull();
    });
  });

  it("reports the bucket that refused, not one that passed after it", () => {
    runWithRateLimitCapture(() => {
      captureRateLimitResult({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: 5_000,
      });
      captureRateLimitResult({
        allowed: true,
        limit: 120,
        remaining: 100,
        resetAt: 9_000,
      });
      expect(capturedRateLimit()).toMatchObject({ limit: 60, resetAt: 5_000 });
    });
  });

  it("gives each scope its own cell", async () => {
    const first = runWithRateLimitCapture(async () => {
      captureRateLimitResult({
        allowed: false,
        limit: 1,
        remaining: 0,
        resetAt: 111,
      });
      await Promise.resolve();
      return capturedRateLimit();
    });
    const second = runWithRateLimitCapture(async () => {
      await Promise.resolve();
      return capturedRateLimit();
    });

    expect((await first)?.resetAt).toBe(111);
    expect(await second).toBeNull();
  });
});
