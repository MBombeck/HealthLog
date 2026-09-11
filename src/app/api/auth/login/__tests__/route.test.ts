/**
 * v1.4.43 W3-SECURITY (H-1) — `auth.login.failed` audit row must not
 * leak the typed identifier (email / username) into operator
 * artefacts. Per the v1.4.20 PII directive, the `reason` field is the
 * only signal operators need; the identifier itself is PII and stays
 * out of the row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    apiToken: { create: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPasswordOrDummy: vi.fn(),
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
    (raw: string) => "aa".repeat(32) + (raw.length % 8).toString(16),
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
import { verifyPasswordOrDummy } from "@/lib/auth/password";
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
  vi.mocked(verifyPasswordOrDummy).mockResolvedValue(false);
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

describe("POST /api/auth/login — OIDC_ONLY server-side enforcement", () => {
  const OIDC_ENV_KEYS = [
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_ONLY",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of OIDC_ENV_KEYS) original[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of OIDC_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("rejects password login before touching the DB when OIDC_ONLY is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("still allows password login when OIDC_ONLY is set but the provider is half-configured", async () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await POST(makeRequest());
    // Falls through to normal password verification (which fails here
    // since verifyPasswordOrDummy is mocked to return false) rather than 403 —
    // a half-set OIDC group must never lock everyone out.
    expect(res.status).toBe(401);
  });
});
