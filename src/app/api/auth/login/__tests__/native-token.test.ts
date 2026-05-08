import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks must come before importing the route. ---

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    apiToken: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn().mockResolvedValue("session-id"),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 5, reset: 0 }),
  rateLimitHeaders: vi.fn(() => ({})),
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
import { verifyPassword } from "@/lib/auth/password";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { ensureDbCompatibility } from "@/lib/db-compat";
import { auditLog } from "@/lib/auth/audit";
import { createSession } from "@/lib/auth/session";

const FAKE_USER = {
  id: "user-1",
  username: "marc",
  email: "marc@example.com",
  passwordHash: "$argon2id$...",
};

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      email: "marc@example.com",
      password: "supersecret",
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.findFirst).mockResolvedValue(FAKE_USER as never);
  vi.mocked(verifyPassword).mockResolvedValue(true);
  vi.mocked(prisma.apiToken.create).mockResolvedValue({ id: "tok-1" } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 5,
    reset: 0,
  } as never);
  vi.mocked(rateLimitHeaders).mockReturnValue({} as never);
  vi.mocked(ensureDbCompatibility).mockResolvedValue(undefined);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(createSession).mockResolvedValue("session-id");
});

describe("POST /api/auth/login — native token issuance", () => {
  it("issues a Bearer token when X-Client-Type: native is set", async () => {
    const original = process.env.API_TOKEN_HMAC_KEY;
    process.env.API_TOKEN_HMAC_KEY = "test-key";
    try {
      const res = await POST(makeRequest({ "x-client-type": "native" }));
      const body = (await res.json()) as {
        data: { user: { id: string }; token?: string; tokenExpiresAt?: string };
      };
      expect(res.status).toBe(200);
      expect(body.data.user.id).toBe("user-1");
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
    const body = (await res.json()) as {
      data: { user: { id: string }; token?: string };
    };
    expect(res.status).toBe(200);
    expect(body.data.user.id).toBe("user-1");
    expect(body.data.token).toBeUndefined();
    expect(prisma.apiToken.create).not.toHaveBeenCalled();
  });

  it("issues a token when User-Agent starts with HealthLog-iOS", async () => {
    const original = process.env.API_TOKEN_HMAC_KEY;
    process.env.API_TOKEN_HMAC_KEY = "test-key";
    try {
      const res = await POST(
        makeRequest({ "user-agent": "HealthLog-iOS/1.0 (iPhone)" }),
      );
      const body = (await res.json()) as { data: { token?: string } };
      expect(res.status).toBe(200);
      expect(body.data.token).toMatch(/^hlk_/);
      const createArgs = vi.mocked(prisma.apiToken.create).mock.calls[0][0];
      expect(createArgs.data.tokenHash).toBe(`hashed:${body.data.token}`);
    } finally {
      process.env.API_TOKEN_HMAC_KEY = original;
    }
  });
});
