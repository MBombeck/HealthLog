import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    requireMfaManagementAuth: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(),
    user: { update: vi.fn() },
    mfaRecoveryCode: { deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  destroyOtherSessions: vi.fn().mockResolvedValue({ sessionsRevoked: 2 }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/mfa/verify-factor", () => ({
  verifyMfaFactor: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

import { POST } from "../route";
import { requireMfaManagementAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { destroyOtherSessions } from "@/lib/auth/session";
import { verifyMfaFactor } from "@/lib/auth/mfa/verify-factor";

function req() {
  return new Request("http://localhost/api/auth/me/mfa/disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "totp", code: "123456" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireMfaManagementAuth).mockResolvedValue({
    transport: "cookie",
    user: { id: "u1" },
    session: { id: "sess-current" },
    commitElevation: vi.fn().mockResolvedValue(undefined),
  } as never);
  vi.mocked(verifyMfaFactor).mockResolvedValue({ ok: true } as never);
  vi.mocked(prisma.$transaction).mockImplementation(async (cb: unknown) => {
    if (typeof cb === "function") {
      return (cb as (tx: unknown) => unknown)({
        user: { update: vi.fn() },
        mfaRecoveryCode: { deleteMany: vi.fn() },
      });
    }
    return undefined;
  });
});

describe("POST /api/auth/me/mfa/disable", () => {
  it("revokes other sessions + trusted devices (via destroyOtherSessions), keeping the current one", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(destroyOtherSessions).toHaveBeenCalledWith("u1", {
      kind: "session",
      sessionId: "sess-current",
    });
  });

  it("spares the CALLER's own device login on the Bearer path", async () => {
    // A Bearer caller has no session row. The earlier revision passed
    // `session.id` — an ApiToken id on this arm — into a session-scoped query,
    // so the "keep the current one" exclusion excluded nothing: every browser
    // session went AND the caller's own refresh token was revoked, logging the
    // app out at its next rotation. A cookie-shaped fixture could never see it.
    vi.mocked(requireMfaManagementAuth).mockResolvedValue({
      transport: "bearer",
      user: { id: "u1" },
      apiTokenId: "token-row-1",
      accessTokenHash: "hash-of-caller-access-token",
      commitElevation: vi.fn().mockResolvedValue(undefined),
    } as never);

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(destroyOtherSessions).toHaveBeenCalledWith("u1", {
      kind: "accessToken",
      accessTokenHash: "hash-of-caller-access-token",
    });
  });

  it("spends the elevation before tearing the factor down", async () => {
    const commitElevation = vi.fn().mockResolvedValue(undefined);
    vi.mocked(requireMfaManagementAuth).mockResolvedValue({
      transport: "bearer",
      user: { id: "u1" },
      apiTokenId: "token-row-1",
      accessTokenHash: "h",
      commitElevation,
    } as never);

    await POST(req());

    expect(commitElevation).toHaveBeenCalledTimes(1);
  });

  it("does NOT spend the elevation when the factor code is wrong", async () => {
    const commitElevation = vi.fn().mockResolvedValue(undefined);
    vi.mocked(requireMfaManagementAuth).mockResolvedValue({
      transport: "bearer",
      user: { id: "u1" },
      apiTokenId: "token-row-1",
      accessTokenHash: "h",
      commitElevation,
    } as never);
    vi.mocked(verifyMfaFactor).mockResolvedValue({
      ok: false,
      replay: false,
    } as never);

    const res = await POST(req());

    expect(res.status).toBe(401);
    expect(commitElevation).not.toHaveBeenCalled();
  });

  it("rejects a wrong current factor without revoking anything", async () => {
    vi.mocked(verifyMfaFactor).mockResolvedValue({
      ok: false,
      replay: false,
    } as never);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(destroyOtherSessions).not.toHaveBeenCalled();
  });
});
