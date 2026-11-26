/**
 * POST /api/auth/password-strength: the strength meter's estimator, served
 * so the browser does not download zxcvbn's dictionaries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import { POST } from "../route";
import {
  checkAuthSurfaceRateLimit,
  type RateLimitResult,
} from "@/lib/rate-limit";

const allowed: RateLimitResult & { ip: string | null } = {
  allowed: true,
  limit: 60,
  remaining: 59,
  resetAt: 0,
  ip: "203.0.113.9",
};

function post(body: unknown) {
  return new NextRequest("http://localhost/api/auth/password-strength", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/password-strength", () => {
  beforeEach(() => {
    vi.mocked(checkAuthSurfaceRateLimit).mockReset();
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue(allowed);
  });

  it("scores a common password low and names the reason", async () => {
    const res = await POST(post({ password: "password1234" }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.score).toBeLessThanOrEqual(1);
    expect(data.warning).not.toBe("");
    expect(Array.isArray(data.suggestions)).toBe(true);
  });

  it("scores a long random passphrase at the top", async () => {
    const res = await POST(
      post({ password: "quartz-lantern-ribbon-meadow-47" }),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.score).toBe(4);
  });

  it("refuses a password past the meter's length with 422, without echoing it", async () => {
    const long = "x".repeat(257);
    const res = await POST(post({ password: long }));
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(long);
  });

  it("answers 429 before reading the body once the address is over its limit", async () => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      ...allowed,
      allowed: false,
    });
    const res = await POST(post({ password: "password1234" }));
    expect(res.status).toBe(429);
  });
});
