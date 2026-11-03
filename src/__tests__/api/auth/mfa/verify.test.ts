import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 1e6,
    ip: "203.0.113.9",
  }),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/auth/login-response", () => ({
  finishLogin: vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ data: { user: { id: "user-1" } }, error: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
}));
vi.mock("@/lib/auth/mfa/challenge", () => ({
  loadActiveChallenge: vi.fn(),
  reserveChallengeAttempt: vi.fn().mockResolvedValue(true),
  recordChallengeFailure: vi
    .fn()
    .mockResolvedValue({ exhausted: false, attempts: 1 }),
  claimChallenge: vi.fn(),
}));
vi.mock("@/lib/auth/mfa/verify-factor", () => ({
  verifyMfaFactor: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "@/app/api/auth/mfa/verify/route";
import { prisma } from "@/lib/db";
import { finishLogin } from "@/lib/auth/login-response";
import {
  loadActiveChallenge,
  reserveChallengeAttempt,
  recordChallengeFailure,
  claimChallenge,
} from "@/lib/auth/mfa/challenge";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";

function verifyRequest(body: unknown) {
  return new Request("http://localhost/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const GOOD_BODY = { mfaTicket: "tkt", method: "totp", code: "123456" };
const ACTIVE_CHALLENGE = {
  id: "ch-1",
  userId: "user-1",
  kind: "login",
  attempts: 0,
  expiresAt: new Date(Date.now() + 60_000),
};
const MFA_USER = {
  id: "user-1",
  username: "u",
  email: "user@example.com",
  onboardingCompletedAt: new Date(),
  totpConfirmedAt: new Date(),
  totpSecretEncrypted: "v2.cipher",
  totpLastStep: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/mfa/verify", () => {
  it("happy path: valid factor → claims ticket and issues the bundle", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(ACTIVE_CHALLENGE as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(MFA_USER as never);
    vi.mocked(verifyMfaFactor).mockResolvedValue({ ok: true, replay: false });
    vi.mocked(claimChallenge).mockResolvedValue(true);

    const res = await POST(verifyRequest(GOOD_BODY));
    expect(res.status).toBe(200);

    expect(claimChallenge).toHaveBeenCalledWith("ch-1");
    expect(finishLogin).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(finishLogin).mock.calls[0][0];
    expect(arg.mfaVerified).toBe(true);
    expect(arg.source).toBe("mfa.verify");
  });

  it("no attempt left to reserve → 401 before the factor is evaluated", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(ACTIVE_CHALLENGE as never);
    vi.mocked(reserveChallengeAttempt).mockResolvedValueOnce(false);

    const res = await POST(verifyRequest(GOOD_BODY));
    expect(res.status).toBe(401);
    expect(verifyMfaFactor).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("invalid ticket → 401, no session", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(null);
    const res = await POST(verifyRequest(GOOD_BODY));
    expect(res.status).toBe(401);
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("wrong code → records failure, 401, no session", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(ACTIVE_CHALLENGE as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(MFA_USER as never);
    vi.mocked(verifyMfaFactor).mockResolvedValue({ ok: false, replay: false });

    const res = await POST(verifyRequest(GOOD_BODY));
    expect(res.status).toBe(401);
    expect(recordChallengeFailure).toHaveBeenCalledWith("ch-1");
    expect(claimChallenge).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("factor valid but claim lost (race) → 401, no session", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(ACTIVE_CHALLENGE as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(MFA_USER as never);
    vi.mocked(verifyMfaFactor).mockResolvedValue({ ok: true, replay: false });
    vi.mocked(claimChallenge).mockResolvedValue(false);

    const res = await POST(verifyRequest(GOOD_BODY));
    expect(res.status).toBe(401);
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("factor disabled between password and verify → failure, 401", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(ACTIVE_CHALLENGE as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...MFA_USER,
      totpConfirmedAt: null,
    } as never);

    const res = await POST(verifyRequest(GOOD_BODY));
    expect(res.status).toBe(401);
    expect(recordChallengeFailure).toHaveBeenCalledWith("ch-1");
    expect(verifyMfaFactor).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("malformed body → 422", async () => {
    const res = await POST(verifyRequest({ mfaTicket: "", code: "x" }));
    expect(res.status).toBe(422);
  });
});
