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
vi.mock("@/lib/logging/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/context")>()),
  annotate: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import { POST } from "../route";
import { annotate } from "@/lib/logging/context";
import { PASSWORD_STRENGTH_MAX_LENGTH } from "@/lib/zxcvbn-i18n";
import {
  checkAuthSurfaceRateLimit,
  type RateLimitResult,
} from "@/lib/rate-limit";

const allowed: RateLimitResult & { ip: string | null } = {
  allowed: true,
  limit: 20,
  remaining: 19,
  resetAt: 0,
  ip: "203.0.113.9",
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/auth/password-strength", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/password-strength", () => {
  beforeEach(() => {
    vi.mocked(checkAuthSurfaceRateLimit).mockReset();
    vi.mocked(annotate).mockClear();
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
    const long = "x".repeat(PASSWORD_STRENGTH_MAX_LENGTH + 1);
    const res = await POST(post({ password: long }));
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(long);
  });

  it("refuses a body past its small cap before parsing it", async () => {
    const res = await POST(post({ password: "x", pad: "y".repeat(1024) }));
    expect(res.status).toBe(413);
  });

  it("spends at most 20 requests a minute per address on the auth-surface bucket", async () => {
    await POST(post({ password: "correct horse" }));
    expect(checkAuthSurfaceRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "auth:password-strength",
      20,
      60 * 1000,
    );
  });

  it("refuses a cross-site browser POST before scoring", async () => {
    const res = await POST(
      post({ password: "correct horse" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
    expect(checkAuthSurfaceRateLimit).not.toHaveBeenCalled();
  });

  it("annotates the action and nothing of the password", async () => {
    const secret = "an unusual phrase 7731";
    await POST(post({ password: secret }));
    expect(annotate).toHaveBeenCalledWith({
      action: { name: "auth.password-strength.estimate" },
    });
    expect(JSON.stringify(vi.mocked(annotate).mock.calls)).not.toContain(
      "7731",
    );
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
