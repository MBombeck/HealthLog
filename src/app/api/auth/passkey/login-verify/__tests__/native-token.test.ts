import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  // v1.4.43 W13 M-4 — passkey/login-verify now uses the auth-surface
  // wrapper. Default to a clean per-IP result.
  checkAuthSurfaceRateLimit: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn((raw: string) => `hashed:${raw}`),
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
import { verifyAuthentication } from "@/lib/auth/passkey";
import {
  checkRateLimit,
  checkAuthSurfaceRateLimit,
} from "@/lib/rate-limit";

const FAKE_USER = {
  id: "user-1",
  username: "marc",
  email: "marc@example.com",
};

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/auth/passkey/login-verify", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      challengeId: "ch-1",
      credential: { id: "cred-1" },
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
  vi.mocked(prisma.apiToken.create).mockResolvedValue({ id: "tok-1" } as never);
  vi.mocked(prisma.refreshToken.create).mockResolvedValue({
    id: "rt-1",
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

describe("POST /api/auth/passkey/login-verify — native token issuance", () => {
  it("issues a Bearer token when X-Client-Type: native is set", async () => {
    const original = process.env.API_TOKEN_HMAC_KEY;
    process.env.API_TOKEN_HMAC_KEY = "test-key";
    try {
      const res = await POST(makeRequest({ "x-client-type": "native" }));
      const body = (await res.json()) as {
        data: { token?: string; tokenExpiresAt?: string };
      };
      expect(res.status).toBe(200);
      expect(body.data.token).toMatch(/^hlk_[a-f0-9]{64}$/);
      expect(body.data.tokenExpiresAt).toEqual(expect.any(String));
      expect(prisma.apiToken.create).toHaveBeenCalledTimes(1);
      const createArgs = vi.mocked(prisma.apiToken.create).mock.calls[0][0];
      expect(createArgs.data.tokenHash).toBe(`hashed:${body.data.token}`);
    } finally {
      process.env.API_TOKEN_HMAC_KEY = original;
    }
  });

  it("does NOT issue a token without the native header", async () => {
    const res = await POST(makeRequest());
    const body = (await res.json()) as { data: { token?: string } };
    expect(res.status).toBe(200);
    expect(body.data.token).toBeUndefined();
    expect(prisma.apiToken.create).not.toHaveBeenCalled();
  });

  it("returns 401 when verification fails", async () => {
    vi.mocked(verifyAuthentication).mockResolvedValue({
      verification: { verified: false },
      passkey: { userId: "user-1" },
    } as never);
    const res = await POST(makeRequest({ "x-client-type": "native" }));
    expect(res.status).toBe(401);
    expect(prisma.apiToken.create).not.toHaveBeenCalled();
  });
});
