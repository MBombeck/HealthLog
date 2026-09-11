import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    webauthnMfaCredential: { count: vi.fn().mockResolvedValue(0) },
  },
}));

vi.mock("@/lib/auth/password", () => ({ verifyPasswordOrDummy: vi.fn() }));

vi.mock("@/lib/auth/login-response", () => ({
  finishLogin: vi.fn(async () => new Response(null, { status: 200 })),
}));

vi.mock("@/lib/auth/mfa/challenge", () => ({
  createMfaChallenge: vi.fn(async () => ({
    ticket: "tkt",
    expiresAt: new Date(),
  })),
}));

vi.mock("@/lib/auth/trusted-device", () => ({
  consumeTrustedDevice: vi.fn(),
}));

vi.mock("@/lib/auth/mfa-enrollment", () => ({
  syncMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  checkAuthSurfaceRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, ip: "1.2.3.4" }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn(() => "h") }));
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
import { finishLogin } from "@/lib/auth/login-response";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";
import { consumeTrustedDevice } from "@/lib/auth/trusted-device";

const MFA_USER = {
  id: "u1",
  username: "u",
  passwordHash: "hash",
  onboardingCompletedAt: null,
  totpConfirmedAt: new Date(),
  mfaEnforced: false,
};

function req() {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "u@example.com", password: "pw-correct" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findFirst).mockResolvedValue(MFA_USER as never);
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0 as never);
});

describe("POST /api/auth/login — trusted device", () => {
  it("skips the second factor when the device is trusted (no challenge minted)", async () => {
    vi.mocked(verifyPasswordOrDummy).mockResolvedValue(true);
    vi.mocked(consumeTrustedDevice).mockResolvedValue(true);

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(createMfaChallenge).not.toHaveBeenCalled();
    expect(finishLogin).toHaveBeenCalledWith(
      expect.objectContaining({ source: "login.password.trusted_device" }),
    );
    // A trusted-device login is NOT step-up fresh — mfaVerified must be absent.
    const arg = vi.mocked(finishLogin).mock.calls[0][0];
    expect(arg.mfaVerified).toBeUndefined();
  });

  it("falls back to the MFA challenge when the device is not trusted", async () => {
    vi.mocked(verifyPasswordOrDummy).mockResolvedValue(true);
    vi.mocked(consumeTrustedDevice).mockResolvedValue(false);

    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta?: { mfaRequired?: boolean } };
    expect(body.meta?.mfaRequired).toBe(true);
    expect(createMfaChallenge).toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("still requires the password — a wrong password never consults the trusted device", async () => {
    vi.mocked(verifyPasswordOrDummy).mockResolvedValue(false);

    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(consumeTrustedDevice).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });
});
