/**
 * POST /api/auth/native/token — web-handoff exchange (iOS #65).
 *
 * Mirrors the OIDC native-token route tests, with the `web_login` flow gate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("@/lib/api-handler", () => ({ apiHandler: (fn: unknown) => fn }));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/native-client", () => ({
  isCookielessNativeCaller: vi.fn(() => true),
}));

vi.mock("@/lib/auth/native-handoff", () => ({
  consumeNativeHandoff: vi.fn(),
  stampIssuedRefreshToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/login-response", () => ({
  finishLogin: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { isCookielessNativeCaller } from "@/lib/auth/native-client";
import {
  consumeNativeHandoff,
  stampIssuedRefreshToken,
} from "@/lib/auth/native-handoff";
import { finishLogin } from "@/lib/auth/login-response";
import { auditLog } from "@/lib/auth/audit";

const VALID_BODY = {
  code: "hlh_" + "a".repeat(43),
  codeVerifier: "a".repeat(43),
};

function makeRequest(
  body: unknown = VALID_BODY,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/auth/native/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-client-type": "native",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function nativeBundleResponse() {
  return NextResponse.json({
    data: {
      user: { id: "user-1", username: "alice" },
      token: "hlk_access",
      tokenExpiresAt: new Date().toISOString(),
      refreshToken: "hlr_refresh",
      refreshTokenExpiresAt: new Date().toISOString(),
    },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "1.2.3.4",
  } as never);
  vi.mocked(isCookielessNativeCaller).mockReturnValue(true);
});

describe("POST /api/auth/native/token", () => {
  it("429 when rate-limited (before any state is touched)", async () => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      ip: "1.2.3.4",
    } as never);
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(consumeNativeHandoff).not.toHaveBeenCalled();
  });

  it("401 and never consumes when the transport is not cookie-less native", async () => {
    vi.mocked(isCookielessNativeCaller).mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(consumeNativeHandoff).not.toHaveBeenCalled();
  });

  it("401 when the caller presents no native marker (browser UA path)", async () => {
    // isCookielessNativeCaller true, but no x-client-type / native UA →
    // isNativeClientRequest false → rejected before any state.
    const res = await POST(makeRequest(VALID_BODY, { "x-client-type": "web" }));
    expect(res.status).toBe(401);
    expect(consumeNativeHandoff).not.toHaveBeenCalled();
  });

  it("422 on a malformed body", async () => {
    const res = await POST(makeRequest({ code: "nope", codeVerifier: "x" }));
    expect(res.status).toBe(422);
    expect(consumeNativeHandoff).not.toHaveBeenCalled();
  });

  it("consumes with the web_login flow gate", async () => {
    vi.mocked(consumeNativeHandoff).mockResolvedValue({
      status: "not_found",
    } as never);
    await POST(makeRequest());
    expect(consumeNativeHandoff).toHaveBeenCalledWith(
      VALID_BODY.code,
      VALID_BODY.codeVerifier,
      "web_login",
    );
  });

  it("returns ONE identical generic 401 across every invalid-code class", async () => {
    const statuses = [
      { status: "not_found" },
      { status: "replayed", userId: "user-1" },
      { status: "expired" },
      { status: "pkce_mismatch" },
      { status: "race_lost" },
    ] as const;

    const bodies: string[] = [];
    for (const s of statuses) {
      vi.mocked(consumeNativeHandoff).mockResolvedValue(s as never);
      const res = await POST(makeRequest());
      expect(res.status).toBe(401);
      bodies.push(await res.text());
    }
    vi.mocked(consumeNativeHandoff).mockResolvedValue({
      status: "ok",
      userId: "user-1",
      handoffId: "ho-1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    bodies.push(await res.text());

    expect(new Set(bodies).size).toBe(1);
  });

  it("does not mint on the deleted-user branch", async () => {
    vi.mocked(consumeNativeHandoff).mockResolvedValue({
      status: "ok",
      userId: "user-1",
      handoffId: "ho-1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    await POST(makeRequest());
    expect(finishLogin).not.toHaveBeenCalled();
  });

  it("200 on success: mints via the web_handoff source, stamps, audits, no mfaVerified", async () => {
    vi.mocked(consumeNativeHandoff).mockResolvedValue({
      status: "ok",
      userId: "user-1",
      handoffId: "ho-1",
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "user-1",
      username: "alice",
      onboardingCompletedAt: new Date(),
    } as never);
    vi.mocked(finishLogin).mockResolvedValue(nativeBundleResponse());

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    const finishArg = vi.mocked(finishLogin).mock.calls[0][0];
    expect(finishArg.source).toBe("login.web_handoff");
    // Never set — the handoff login can't satisfy step-up.
    expect(finishArg.mfaVerified).toBeUndefined();

    expect(stampIssuedRefreshToken).toHaveBeenCalledWith("ho-1", "hlr_refresh");
    expect(auditLog).toHaveBeenCalledWith(
      "auth.login",
      expect.objectContaining({
        userId: "user-1",
        details: { transport: "native", method: "web_handoff" },
      }),
    );

    const body = await res.json();
    expect(body.data.refreshToken).toBe("hlr_refresh");
  });

  it("is NOT blocked by OIDC_ONLY", async () => {
    const prev = process.env.OIDC_ONLY;
    process.env.OIDC_ONLY = "true";
    try {
      vi.mocked(consumeNativeHandoff).mockResolvedValue({
        status: "ok",
        userId: "user-1",
        handoffId: "ho-1",
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-1",
        username: "alice",
        onboardingCompletedAt: new Date(),
      } as never);
      vi.mocked(finishLogin).mockResolvedValue(nativeBundleResponse());
      const res = await POST(makeRequest());
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.OIDC_ONLY;
      else process.env.OIDC_ONLY = prev;
    }
  });
});
