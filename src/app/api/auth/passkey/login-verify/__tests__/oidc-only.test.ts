import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    apiToken: { create: vi.fn() },
    refreshToken: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/passkey", () => ({
  verifyAuthentication: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn().mockResolvedValue("session-id"),
  setOnboardingPendingCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/mfa-enrollment", () => ({
  syncMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/login-alert", () => ({
  recordSignInDevice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn((raw: string) => `hashed:${raw}`),
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
import { verifyAuthentication } from "@/lib/auth/passkey";
import { checkRateLimit, checkAuthSurfaceRateLimit } from "@/lib/rate-limit";

const OIDC_ENV_KEYS = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_ONLY",
] as const;
const original: Record<string, string | undefined> = {};

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/auth/passkey/login-verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: "ch-1", credential: { id: "cred-1" } }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of OIDC_ENV_KEYS) original[key] = process.env[key];
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: "user-1",
    username: "testuser",
    email: "user@example.com",
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    reset: 0,
  } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: 0,
    ip: "203.0.113.1",
  } as never);
  vi.mocked(verifyAuthentication).mockResolvedValue({
    verification: { verified: true },
    passkey: { userId: "user-1" },
  } as never);
});

afterEach(() => {
  for (const key of OIDC_ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("POST /api/auth/passkey/login-verify — OIDC_ONLY server-side enforcement", () => {
  it("rejects passkey login before touching WebAuthn verification when OIDC_ONLY is set", async () => {
    process.env.OIDC_ISSUER_URL = "https://idp.example.com";
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect(verifyAuthentication).not.toHaveBeenCalled();
  });

  it("still allows passkey login when OIDC_ONLY is set but the provider is half-configured", async () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_CLIENT_ID = "client-1";
    process.env.OIDC_CLIENT_SECRET = "secret-1";
    process.env.OIDC_ONLY = "true";

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});
