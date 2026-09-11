import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth/mfa-enrollment", () => ({
  setMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
  syncMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    webauthnMfaCredential: { count: vi.fn().mockResolvedValue(0) },
  },
}));
vi.mock("@/lib/auth/password", () => ({
  verifyPasswordOrDummy: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn(() => "h") }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: Date.now() + 1e6,
    ip: "203.0.113.7",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/auth/login-response", () => ({
  finishLogin: vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ data: { user: { id: "user-1" } }, error: null }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
  ),
}));
vi.mock("@/lib/auth/mfa/challenge", () => ({
  createMfaChallenge: vi.fn().mockResolvedValue({
    ticket: "opaque-ticket-value",
    expiresAt: new Date(Date.now() + 5 * 60_000),
  }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "@/app/api/auth/login/route";
import { prisma } from "@/lib/db";
import { finishLogin } from "@/lib/auth/login-response";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";

function loginRequest() {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "user@example.com",
      password: "correct-horse-battery",
    }),
  }) as unknown as Parameters<typeof POST>[0];
}

const BASE_USER = {
  id: "user-1",
  username: "u",
  email: "user@example.com",
  passwordHash: "argon2-hash",
  onboardingCompletedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no registered security key. Individual tests override as needed.
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
});

describe("login MFA branch", () => {
  it("MFA user → returns mfaRequired + ticket and issues NO session", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...BASE_USER,
      totpConfirmedAt: new Date(),
    } as never);

    const res = await POST(loginRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toBeNull();
    expect(body.error).toBeNull();
    expect(body.meta.mfaRequired).toBe(true);
    expect(body.meta.mfaTicket).toBe("opaque-ticket-value");
    expect(body.meta.methods).toEqual(["totp", "recovery"]);

    expect(createMfaChallenge).toHaveBeenCalledWith("user-1", "login");
    // The session/token tail is never reached.
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("WebAuthn-only user (no TOTP) → returns mfaRequired with webauthn method", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...BASE_USER,
      totpConfirmedAt: null,
    } as never);
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1 as never);

    const res = await POST(loginRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.meta.mfaRequired).toBe(true);
    expect(body.meta.methods).toEqual(["webauthn"]);
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("non-MFA user → issues the session via finishLogin, no challenge", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...BASE_USER,
      totpConfirmedAt: null,
    } as never);

    const res = await POST(loginRequest());
    expect(res.status).toBe(200);

    expect(finishLogin).toHaveBeenCalledTimes(1);
    expect(createMfaChallenge).not.toHaveBeenCalled();
    const arg = vi.mocked(finishLogin).mock.calls[0][0];
    expect(arg.source).toBe("login.password");
    expect(arg.mfaVerified).toBeUndefined();
  });

  it("wrong password never reaches the MFA branch", async () => {
    const { verifyPasswordOrDummy } = await import("@/lib/auth/password");
    vi.mocked(verifyPasswordOrDummy).mockResolvedValueOnce(false);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...BASE_USER,
      totpConfirmedAt: new Date(),
    } as never);

    const res = await POST(loginRequest());
    expect(res.status).toBe(401);
    expect(createMfaChallenge).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });
});
