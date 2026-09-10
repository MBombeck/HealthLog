/**
 * Token endpoint — PKCE verification, audience binding, single-use codes,
 * refresh-token rotation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.API_TOKEN_HMAC_KEY = "x".repeat(48);
process.env.APP_URL = "https://health.example";

const { transactionClient, transaction } = vi.hoisted(() => {
  const transactionClient = { marker: "mcp-refresh-transaction" };
  return {
    transactionClient,
    transaction: vi.fn(
      async (callback: (tx: typeof transactionClient) => unknown) =>
        callback(transactionClient),
    ),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { $transaction: transaction },
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/issue-token", () => ({
  issueApiToken: vi.fn(async () => ({
    token: "hlk_" + "a".repeat(64),
    expiresAt: new Date(Date.now() + 3_600_000),
    tokenId: "tok-1",
    name: "MCP connector",
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 60,
    remaining: 100,
    resetAt: Date.now() + 60_000,
    ip: "1.2.3.4",
  })),
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 60,
    remaining: 0,
    resetAt: Date.now() + 60_000,
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/mcp/oauth/connections", () => ({
  createConnection: vi.fn(async () => "conn-1"),
  rotateConnection: vi.fn(async () => ({ ok: true })),
}));

import { randomUUID } from "node:crypto";
import { POST } from "../token/route";
import { issueApiToken } from "@/lib/auth/issue-token";
import { checkRateLimit } from "@/lib/rate-limit";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import {
  createConnection,
  rotateConnection,
} from "@/lib/mcp/oauth/connections";
import { signArtifact, verifyArtifact } from "@/lib/mcp/oauth/artifacts";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";

const CLIENT_ID = "https://app.example/client.json";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const CHALLENGE = s256Challenge(VERIFIER);
const RESOURCE = "https://health.example/mcp";

function authCode(overrides: Record<string, unknown> = {}): string {
  return signArtifact(
    "authCode",
    {
      jti: randomUUID(),
      sub: "user-1",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      scope: "health:read offline_access",
      resource: RESOURCE,
      ...overrides,
    },
    120_000,
  );
}

function tokenReq(fields: Record<string, string>): Request {
  return new Request("https://health.example/api/mcp/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 0,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(createConnection).mockResolvedValue("conn-1");
  vi.mocked(rotateConnection).mockResolvedValue({ ok: true });
  transaction.mockImplementation(
    async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient),
  );
});

function refreshToken(overrides: Record<string, unknown> = {}): string {
  return signArtifact(
    "refreshToken",
    {
      jti: randomUUID(),
      cid: "conn-1",
      sub: "user-1",
      client_id: CLIENT_ID,
      scope: "health:read offline_access",
      resource: RESOURCE,
      ...overrides,
    },
    1_000_000,
  );
}

describe("authorization_code grant", () => {
  it("exchanges a valid code + verifier for an access token (+ refresh)", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^hlk_/);
    expect(body.refresh_token).toMatch(/^hlrt_/);
    expect(body.scope).toContain("health:read");
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: ["health:read"] }),
    );
  });

  it("creates a revocable connection anchor and links the access token (H2)", async () => {
    await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({ mcpConnectionId: "conn-1" }),
    );
  });

  it("rejects a wrong PKCE verifier with invalid_grant", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: "b".repeat(64),
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("rejects a code bound to a different audience", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode({ resource: "https://evil.example/mcp" }),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_target");
  });

  it("rejects a code presented by a different client", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: "https://other.example/client.json",
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rejects a replayed code (single-use jti already claimed)", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(issueApiToken).not.toHaveBeenCalled();
  });
});

describe("refresh_token grant", () => {
  it("rotates: issues a new access + refresh pair against a live connection", async () => {
    const presented = refreshToken({ jti: "presented-jti" });
    const res = await POST(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: presented,
        client_id: CLIENT_ID,
      }) as never,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.access_token).toMatch(/^hlk_/);
    expect(body.refresh_token).toMatch(/^hlrt_/);
    expect(vi.mocked(rotateConnection).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        connectionId: "conn-1",
        clientId: CLIENT_ID,
        presentedJti: "presented-jti",
      }),
    );

    const successor = verifyArtifact<{
      cid: string;
      jti: string;
      sub: string;
    }>("refreshToken", body.refresh_token);
    expect(successor.ok).toBe(true);
    if (successor.ok) {
      expect(successor.claims.cid).toBe("conn-1");
      expect(successor.claims.sub).toBe("user-1");
      expect(successor.claims.jti).not.toBe("presented-jti");
    }
  });

  it("rotates and inserts the successor access token inside one transaction", async () => {
    const res = await POST(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: refreshToken({ jti: "transactional-jti" }),
        client_id: CLIENT_ID,
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(rotateConnection).toHaveBeenCalledWith(
      expect.objectContaining({ presentedJti: "transactional-jti" }),
      transactionClient,
    );
    expect(issueApiToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        mcpConnectionId: "conn-1",
      }),
      transactionClient,
    );
  });

  it("rolls back JTI advancement and access revocation when successor insertion fails", async () => {
    const state = { currentJti: "rollback-jti", accessRevoked: false };
    vi.mocked(rotateConnection).mockImplementationOnce(async (args) => {
      state.currentJti = args.newJti;
      state.accessRevoked = true;
      return { ok: true };
    });
    vi.mocked(issueApiToken).mockRejectedValueOnce(
      new Error("injected successor insertion failure"),
    );
    transaction.mockImplementationOnce(async (callback) => {
      const snapshot = { ...state };
      try {
        return await callback(transactionClient);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    });

    await expect(
      POST(
        tokenReq({
          grant_type: "refresh_token",
          refresh_token: refreshToken({ jti: "rollback-jti" }),
          client_id: CLIENT_ID,
        }) as never,
      ),
    ).rejects.toThrow("injected successor insertion failure");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(state).toEqual({
      currentJti: "rollback-jti",
      accessRevoked: false,
    });
  });

  it("rejects a refresh whose connection was revoked (H2 — settings revoke)", async () => {
    vi.mocked(rotateConnection).mockResolvedValue({
      ok: false,
      reason: "revoked",
    });
    const res = await POST(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: refreshToken(),
        client_id: CLIENT_ID,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("rejects a replayed refresh and reports reuse detection (H2)", async () => {
    vi.mocked(rotateConnection).mockResolvedValue({
      ok: false,
      reason: "reuse_detected",
    });
    const res = await POST(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: refreshToken(),
        client_id: CLIENT_ID,
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/reuse/i);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it("rejects a legacy refresh token with no connection binding", async () => {
    const legacy = signArtifact(
      "refreshToken",
      {
        jti: randomUUID(),
        sub: "user-1",
        client_id: CLIENT_ID,
        scope: "health:read offline_access",
        resource: RESOURCE,
      },
      1_000_000,
    );
    const res = await POST(
      tokenReq({
        grant_type: "refresh_token",
        refresh_token: legacy,
        client_id: CLIENT_ID,
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(rotateConnection).not.toHaveBeenCalled();
  });
});

describe("operator kill-switch + origin config (M1/M4)", () => {
  it("refuses to mint when the API is globally disabled", async () => {
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(
      tokenReq({
        grant_type: "authorization_code",
        code: authCode(),
        code_verifier: VERIFIER,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
      }) as never,
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("temporarily_unavailable");
    expect(issueApiToken).not.toHaveBeenCalled();
  });
});

describe("grant validation", () => {
  it("rejects an unsupported grant_type", async () => {
    const res = await POST(tokenReq({ grant_type: "password" }) as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});
