/**
 * Guard: the MCP connector mint endpoint mints ONLY the two allowed scope
 * shapes — `["health:read"]` (default) or `["health:read","health:write"]` —
 * and never a wildcard or any other grant.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    stepUpElevation: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn() },
    session: {
      findUnique: vi.fn(async () => ({
        createdAt: new Date(),
        mfaVerifiedAt: null,
        reproofAt: null,
      })),
    },
    webauthnMfaCredential: { count: vi.fn(async () => 0) },
    passkey: { count: vi.fn(async () => 0) },
    // The password hash is read off the stored row; none here.
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));
vi.mock("@/lib/app-settings", () => ({ isApiGloballyEnabled: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(),
}));
const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

import { POST } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { issueApiToken } from "@/lib/auth/issue-token";
import { auditLog } from "@/lib/auth/audit";
import type { ApiToken, StepUpElevation } from "@/generated/prisma/client";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mcp/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  headersGet.mockReturnValue(null);
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(issueApiToken).mockResolvedValue({
    token: "hlk_abc",
    tokenId: "tok-1",
    name: "n",
    expiresAt: new Date(),
  });
});

describe("POST /api/mcp/tokens — fresh proof", () => {
  it("refuses a browser session with no recent sign-in or re-proof", async () => {
    vi.mocked(prisma.session.findUnique).mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      mfaVerifiedAt: null,
      reproofAt: null,
    } as never);
    const res = await POST(postReq({ name: "laptop" }));
    expect(res.status).toBe(401);
    expect((await res.json()).meta.errorCode).toBe("auth.reproof.required");
    expect(issueApiToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/tokens — app token (Bearer)", () => {
  const PLAIN = {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    totpConfirmedAt: null,
  };
  const ENROLLED = { ...PLAIN, totpConfirmedAt: new Date("2020-01-01") };

  const APP_TOKEN: ApiToken = {
    id: "tok-app",
    userId: "user-1",
    name: "iPhone",
    tokenHash: "hash(hlk_app)",
    permissions: ["*"],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    revoked: false,
    mcpConnectionId: null,
    mirrorToAppleHealth: false,
    mirrorChangedAt: null,
  };

  function bearer(user: unknown, elevation: string | null = null) {
    vi.mocked(getSession).mockResolvedValue(null);
    headersGet.mockImplementation((n) => {
      const name = n.toLowerCase();
      if (name === "authorization") return "Bearer hlk_app";
      if (name === "x-step-up") return elevation;
      return null;
    });
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(APP_TOKEN);
    vi.mocked(prisma.apiToken.update).mockResolvedValue(APP_TOKEN);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0);
    vi.mocked(prisma.passkey.count).mockResolvedValue(0);
  }

  const elevationRow = (method: string): StepUpElevation => ({
    id: "elev-1",
    userId: "user-1",
    apiTokenId: "tok-app",
    tokenHash: "hash(hle)",
    method,
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
  });

  it("mints on the token alone for an account with no second factor and no passkey", async () => {
    bearer(PLAIN);
    const res = await POST(postReq({ name: "phone" }));
    expect(res.status).toBe(201);
    expect(issueApiToken).toHaveBeenCalledTimes(1);
  });

  it("refuses a bare token on an account with a second factor", async () => {
    bearer(ENROLLED);
    const res = await POST(postReq({ name: "phone" }));
    expect(res.status).toBe(401);
    expect((await res.json()).meta.errorCode).toBe("auth.stepup.required");
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("refuses a bare token on an account whose only strong credential is a passkey", async () => {
    bearer(PLAIN);
    vi.mocked(prisma.passkey.count).mockResolvedValue(1);
    const res = await POST(postReq({ name: "phone" }));
    expect(res.status).toBe(401);
    expect((await res.json()).meta.errorCode).toBe("auth.stepup.required");
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("mints with a second-factor elevation and spends it before minting", async () => {
    bearer(ENROLLED, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      elevationRow("totp"),
    );
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ method: "totp" }]);
    const res = await POST(postReq({ name: "phone" }));
    expect(res.status).toBe(201);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(issueApiToken).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(issueApiToken).mock.invocationCallOrder[0]);
  });

  it("does not mint when the elevation was already spent", async () => {
    bearer(ENROLLED, `hle_${"a".repeat(64)}`);
    vi.mocked(prisma.stepUpElevation.findUnique).mockResolvedValue(
      elevationRow("totp"),
    );
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    const res = await POST(postReq({ name: "phone" }));
    expect(res.status).toBe(401);
    expect(issueApiToken).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp/tokens — scope minting", () => {
  it("defaults to read-only [health:read]", async () => {
    const res = await POST(postReq({ name: "laptop" }));
    expect(res.status).toBe(201);
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ["health:read"] }),
    );
  });

  it("mints read+write when scope=read_write", async () => {
    const res = await POST(postReq({ name: "laptop", scope: "read_write" }));
    expect(res.status).toBe(201);
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: ["health:read", "health:write"],
      }),
    );
  });

  it("rejects any scope outside the closed set (no wildcard path)", async () => {
    for (const bad of ["*", "admin", "health:write", "write", "read_admin"]) {
      vi.mocked(issueApiToken).mockClear();
      const res = await POST(postReq({ name: "x", scope: bad }));
      expect(res.status).toBe(422);
      expect(issueApiToken).not.toHaveBeenCalled();
    }
  });

  it("never mints a wildcard for any input", async () => {
    await POST(postReq({ name: "a" }));
    await POST(postReq({ name: "b", scope: "read_write" }));
    for (const call of vi.mocked(issueApiToken).mock.calls) {
      expect(call[0].permissions).not.toContain("*");
    }
  });
});
