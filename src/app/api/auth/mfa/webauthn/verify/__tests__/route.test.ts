import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/mfa-enrollment", () => ({
  setMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
  syncMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/mfa/challenge", () => ({
  loadActiveChallenge: vi.fn(),
  reserveChallengeAttempt: vi.fn().mockResolvedValue(true),
  recordChallengeFailure: vi.fn().mockResolvedValue({ exhausted: false }),
  claimChallenge: vi.fn(),
}));

vi.mock("@/lib/auth/mfa/webauthn", () => ({
  verifyMfaAuthentication: vi.fn(),
}));

vi.mock("@/lib/auth/login-response", () => ({
  finishLogin: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import {
  loadActiveChallenge,
  reserveChallengeAttempt,
  claimChallenge,
  recordChallengeFailure,
} from "@/lib/auth/mfa/challenge";
import { verifyMfaAuthentication } from "@/lib/auth/mfa/webauthn";
import { finishLogin } from "@/lib/auth/login-response";

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/auth/mfa/webauthn/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  mfaTicket: "ticket-1",
  challengeId: "ch-1",
  credential: {
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: {},
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "203.0.113.1",
  } as never);
  vi.mocked(loadActiveChallenge).mockResolvedValue({
    id: "mfa-1",
    userId: "user-1",
    kind: "login",
    attempts: 0,
    expiresAt: new Date(Date.now() + 60_000),
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: "user-1",
    username: "u",
    onboardingCompletedAt: new Date(),
  } as never);
  vi.mocked(reserveChallengeAttempt).mockResolvedValue(true);
  vi.mocked(recordChallengeFailure).mockResolvedValue({
    exhausted: false,
    attempts: 1,
  } as never);
  vi.mocked(finishLogin).mockResolvedValue(
    new Response(JSON.stringify({ data: { user: { id: "user-1" } } }), {
      status: 200,
    }),
  );
});

describe("POST /api/auth/mfa/webauthn/verify", () => {
  it("finishes login when the assertion verifies and the ticket is claimed", async () => {
    vi.mocked(verifyMfaAuthentication).mockResolvedValue(true as never);
    vi.mocked(claimChallenge).mockResolvedValue(true as never);

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(200);
    expect(verifyMfaAuthentication).toHaveBeenCalledWith(
      "ch-1",
      "user-1",
      VALID_BODY.credential,
    );
    expect(claimChallenge).toHaveBeenCalledWith("mfa-1");
    expect(finishLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        mfaVerified: true,
        source: "mfa.webauthn.verify",
      }),
    );
  });

  it("refuses before the assertion runs when no attempt can be reserved", async () => {
    vi.mocked(reserveChallengeAttempt).mockResolvedValue(false);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect(verifyMfaAuthentication).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("rejects with 401 and burns an attempt when the assertion fails", async () => {
    vi.mocked(verifyMfaAuthentication).mockResolvedValue(false as never);

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(recordChallengeFailure).toHaveBeenCalledWith("mfa-1");
    expect(claimChallenge).not.toHaveBeenCalled();
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("rejects with 401 for an unknown / expired ticket", async () => {
    vi.mocked(loadActiveChallenge).mockResolvedValue(null as never);

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(verifyMfaAuthentication).not.toHaveBeenCalled();
  });

  it("does not mint a session if the ticket claim is lost (concurrent)", async () => {
    vi.mocked(verifyMfaAuthentication).mockResolvedValue(true as never);
    vi.mocked(claimChallenge).mockResolvedValue(false as never);

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(401);
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      ip: "203.0.113.1",
    } as never);

    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
  });
});
