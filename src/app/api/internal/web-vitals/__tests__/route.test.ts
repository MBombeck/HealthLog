import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.28 R4-CODE-C3 / Security H-1 / SD-C2 — the web-vitals beacon
 * is unauthenticated by design (browser fires before any session) but
 * MUST gate the surface so a peer cannot flood the wide-event log nor
 * inject arbitrary strings.
 *
 * Contract:
 *
 *   - Zod schema rejects unknown `name`, non-finite `value`, oversized
 *     `id` → 400. Raw body never enters the log.
 *   - Per-IP rate-limit (60/min) → 429 with `X-RateLimit-*` headers on
 *     overflow.
 *   - Valid payload → 204 No Content (sendBeacon shape — never retry).
 */

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { checkRateLimit } from "@/lib/rate-limit";

function postRequest(body: unknown, init?: { referer?: string }): NextRequest {
  return new NextRequest("http://localhost/api/internal/web-vitals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init?.referer ? { referer: init.referer } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
  // NEXT_PUBLIC_APP_URL unset in the unit harness — the same-origin
  // gate is skipped (dev-friendly default).
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe("POST /api/internal/web-vitals", () => {
  it("returns 204 on a valid payload", async () => {
    const res = await POST(
      postRequest({
        name: "LCP",
        value: 1234.5,
        id: "v1-1700000000-7",
        delta: 12.3,
        rating: "good",
        navigationType: "navigate",
      }),
    );
    expect(res.status).toBe(204);
  });

  it("returns 400 when the name is not in the documented set", async () => {
    const res = await POST(
      postRequest({
        name: "ARBITRARY_LOG_STRING",
        value: 0,
        id: "x",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is non-finite", async () => {
    const res = await POST(
      postRequest({
        name: "CLS",
        value: Number.NaN,
        id: "x",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when id exceeds the 50-char cap", async () => {
    const res = await POST(
      postRequest({
        name: "INP",
        value: 12,
        id: "a".repeat(51),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on malformed JSON without logging the raw payload", async () => {
    const res = await POST(postRequest("not-json"));
    expect(res.status).toBe(400);
  });

  it("returns 429 when the rate-limit fires", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      postRequest({ name: "CLS", value: 0.1, id: "x" }),
    );
    expect(res.status).toBe(429);
  });

  it("rejects a cross-origin Referer when NEXT_PUBLIC_APP_URL is configured", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.com";
    const res = await POST(
      postRequest(
        { name: "LCP", value: 1000, id: "x" },
        { referer: "https://malicious.example.org/probe" },
      ),
    );
    expect(res.status).toBe(204);
    // The beacon was silently dropped (no log line); the rate-limiter
    // was never even consulted for a cross-site request.
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it("accepts a same-origin Referer when NEXT_PUBLIC_APP_URL is configured", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.com";
    const res = await POST(
      postRequest(
        { name: "LCP", value: 1000, id: "x" },
        { referer: "https://healthlog.example.com/insights" },
      ),
    );
    expect(res.status).toBe(204);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });
});
