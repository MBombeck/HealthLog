/**
 * v1.4.43 W3-SECURITY (H-1) — `auth.login.failed` audit row must not
 * leak the typed identifier (email / username) into operator
 * artefacts. Per the v1.4.20 PII directive, the `reason` field is the
 * only signal operators need; the identifier itself is PII and stays
 * out of the row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    apiToken: { create: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn().mockResolvedValue("session-id"),
  setOnboardingPendingCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 5, reset: 0 }),
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 5,
    reset: 0,
    ip: "1.2.3.4",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/hmac", () => ({
  // Return a deterministic hex string that does NOT echo the raw
  // value — mirrors the real HMAC-SHA256 shape. The audit row's
  // privacy contract is "the typed identifier never serialises into
  // the row's body", so the mock must not embed the raw input.
  hashToken: vi.fn(
    (raw: string) =>
      "aa".repeat(32) + (raw.length % 8).toString(16),
  ),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { auditLog } from "@/lib/auth/audit";
import {
  checkRateLimit,
  checkAuthSurfaceRateLimit,
  rateLimitHeaders,
} from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";

const TYPED_EMAIL = "leaked-identifier@example.com";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: TYPED_EMAIL, password: "supersecret" }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);
  vi.mocked(verifyPassword).mockResolvedValue(false);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    reset: 0,
  } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    reset: 0,
    ip: "1.2.3.4",
  } as never);
  vi.mocked(rateLimitHeaders).mockReturnValue({} as never);
  vi.mocked(ensureDbCompatibility).mockResolvedValue(undefined);
});

describe("POST /api/auth/login — auth.login.failed audit row (H-1)", () => {
  it("does NOT include the typed identifier in the audit details", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);

    expect(auditLog).toHaveBeenCalledWith(
      "auth.login.failed",
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "user_not_found_or_no_password",
        }),
      }),
    );

    // Pin the absence: neither the literal identifier string nor an
    // `identifier` key may appear anywhere in the audit-row JSON.
    const calls = vi.mocked(auditLog).mock.calls;
    const failedCall = calls.find((c) => c[0] === "auth.login.failed");
    expect(failedCall).toBeDefined();
    const payload = failedCall![1] as { details?: Record<string, unknown> };
    expect(payload.details).toBeDefined();
    expect(Object.keys(payload.details!)).not.toContain("identifier");
    expect(JSON.stringify(payload)).not.toContain(TYPED_EMAIL);
  });
});
