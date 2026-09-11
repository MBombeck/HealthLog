/**
 * Every login outcome reaches the verifier.
 *
 * The three refusals sign-in can produce — no such account, an account with
 * no password hash, a wrong password — return the identical 401 body, and
 * used to take three very different amounts of time to produce it, because
 * the first two returned before any hashing happened. Argon2id at 19 MiB and
 * t=2 against one indexed SELECT is a gap a caller can read over a network.
 *
 * The passkey-only account is the case that matters most. If it kept the
 * cheap path, the channel would still answer "this account exists and has no
 * password" — which is exactly what the removed discovery endpoint published
 * in a field.
 *
 * What this proves is that the call happens on all three arms, not that the
 * three durations match: the verifier is mocked here, and wall-clock equality
 * is not something a unit test can assert. `password-dummy-verify.test.ts`
 * carries the other half, that the verifier really does Argon2id work at the
 * real cost parameters when there is no stored hash.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    webauthnMfaCredential: { count: vi.fn().mockResolvedValue(0) },
  },
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPasswordOrDummy: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
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
  hashToken: vi.fn(() => "aa".repeat(32)),
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
import { prisma } from "@/lib/db";
import { verifyPasswordOrDummy } from "@/lib/auth/password";

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "someone@example.com",
      password: "a-typed-password",
    }),
  });
}

beforeEach(() => {
  vi.mocked(verifyPasswordOrDummy).mockReset();
  vi.mocked(verifyPasswordOrDummy).mockResolvedValue(false);
});

describe("POST /api/auth/login — constant work across the refusals", () => {
  it("verifies even when no account matches the identifier", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(verifyPasswordOrDummy).toHaveBeenCalledTimes(1);
    expect(verifyPasswordOrDummy).toHaveBeenCalledWith(
      undefined,
      "a-typed-password",
    );
  });

  it("verifies for a passkey-only account, which carries no password hash", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-1",
      passwordHash: null,
      totpConfirmedAt: null,
      mfaEnforced: false,
    } as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(verifyPasswordOrDummy).toHaveBeenCalledTimes(1);
    expect(verifyPasswordOrDummy).toHaveBeenCalledWith(
      null,
      "a-typed-password",
    );
  });

  it("verifies for an account that does carry a password hash", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user-2",
      passwordHash: "$argon2id$stored",
      totpConfirmedAt: null,
      mfaEnforced: false,
    } as never);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(verifyPasswordOrDummy).toHaveBeenCalledTimes(1);
    expect(verifyPasswordOrDummy).toHaveBeenCalledWith(
      "$argon2id$stored",
      "a-typed-password",
    );
  });

  it("answers the three refusals with the identical status and body", async () => {
    const bodies: string[] = [];
    const statuses: number[] = [];
    const accounts = [
      null,
      { id: "user-1", passwordHash: null },
      { id: "user-2", passwordHash: "$argon2id$stored" },
    ];
    for (const account of accounts) {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(account as never);
      const res = await POST(makeRequest());
      statuses.push(res.status);
      bodies.push(await res.text());
    }
    expect(new Set(statuses)).toEqual(new Set([401]));
    expect(new Set(bodies).size).toBe(1);
  });
});
