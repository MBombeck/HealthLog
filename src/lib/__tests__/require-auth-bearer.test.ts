import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks must be hoisted before importing the module under test. ---

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/auth/hmac", () => ({
  hashToken: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

const headersGet = vi.fn<(name: string) => string | null>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: headersGet })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// --- Imports use the mocked modules above. ---

import { requireAuth, HttpError, apiHandler } from "../api-handler";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/hmac";
import { auditLog } from "@/lib/auth/audit";

const FAKE_HASH = "deadbeefcafef00d";
const RAW_TOKEN = "hlk_" + "a".repeat(64);

const FAKE_USER = {
  id: "user-1",
  role: "USER" as const,
  username: "testuser",
  email: "user@example.com",
};

function setBearerHeader(value: string | null): void {
  headersGet.mockReset();
  headersGet.mockImplementation((name: string) =>
    name.toLowerCase() === "authorization" ? value : null,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hashToken).mockReturnValue(FAKE_HASH);
  vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
});

describe("requireAuth — Bearer token path", () => {
  it("authenticates a valid Bearer token and returns AuthContext", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const ctx = await requireAuth();

    expect(hashToken).toHaveBeenCalledWith(RAW_TOKEN);
    // V3 audit: pin the where-clause shape — a regression that switches
    // back to raw-token comparison (where: { tokenHash: RAW_TOKEN }) would
    // be a CRITICAL leak of stored hashes. Tests must enforce the hash.
    expect(prisma.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: FAKE_HASH } }),
    );
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.session.id).toBe("token-1");
    expect(ctx.session.expiresAt).toEqual(expiresAt);

    // lastUsedAt refresh is fire-and-forget but should still have been triggered.
    expect(prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: "token-1" },
      data: { lastUsedAt: expect.any(Date) },
    });
    // v1.25 — the success path no longer writes a per-request audit row; the
    // wide event carries `auth_method: "bearer"` + `user_id` instead.
    expect(auditLog).not.toHaveBeenCalledWith(
      "auth.bearer.success",
      expect.anything(),
    );
  });

  it("rejects a revoked token with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-2",
      userId: "user-1",
      permissions: [],
      revoked: true,
      expiresAt: null,
    } as never);

    await expect(requireAuth()).rejects.toMatchObject({
      statusCode: 401,
    } satisfies Partial<HttpError>);
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "revoked" }),
      }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an expired token with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-3",
      userId: "user-1",
      permissions: [],
      revoked: false,
      expiresAt: new Date(Date.now() - 60_000),
    } as never);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "expired" }),
      }),
    );
  });

  it("rejects an unknown token with 401", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({ reason: "unknown_token" }),
      }),
    );
  });

  it("rejects a Bearer token missing the requested permission with 403", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-4",
      userId: "user-1",
      permissions: ["something:else"],
      revoked: false,
      expiresAt: null,
    } as never);

    await expect(requireAuth("medication:ingest")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "insufficient_permissions",
          required: "medication:ingest",
        }),
      }),
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  // Supersedes the v1.4.25 "a route that declares no scope is content with any
  // authenticated token" policy. That policy was adopted to unbreak four
  // scopeless routes for narrow-token callers, and in doing so it handed every
  // narrow token the full authenticated surface — the escalation this replaces.
  // The right fix for a route that genuinely wants a narrow token is for that
  // route to name the scope, which is a visible diff.
  //
  // The fail-closed default. Bare `requireAuth()` means "cookie session or
  // cookie-equivalent token" — a narrow token is refused, and the audit row
  // says why so an operator can name the token and its owner.
  it("refuses a narrow-scope Bearer token when the route declared no scope", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5a",
      userId: "user-1",
      permissions: ["medication:ingest"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    await expect(requireAuth()).rejects.toMatchObject({
      statusCode: 403,
      message: "Insufficient permissions",
    } satisfies Partial<HttpError>);
    expect(auditLog).toHaveBeenCalledWith(
      "auth.bearer.failure",
      expect.objectContaining({
        userId: "user-1",
        details: expect.objectContaining({
          reason: "undeclared_scope",
          tokenId: "token-5a",
        }),
      }),
    );
    // The user row is never loaded — the deny happens on the token alone.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("admits a narrow-scope Bearer token on a route that names its scope", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5a2",
      userId: "user-1",
      permissions: ["fhir:read"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const ctx = await requireAuth("fhir:read");
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.session.id).toBe("token-5a2");
  });

  it("accepts a wildcard Bearer token when the route did not declare a scope", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5b",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const ctx = await requireAuth();
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.session.id).toBe("token-5b");
  });

  it("accepts a narrow-scope Bearer token when the route's required scope matches", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "token-5c",
      userId: "user-1",
      permissions: ["medication:ingest"],
      revoked: false,
      expiresAt: null,
    } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);

    const ctx = await requireAuth("medication:ingest");
    expect(ctx.user.id).toBe("user-1");
    expect(ctx.session.id).toBe("token-5c");
  });

  it("returns 401 when neither cookie nor Bearer is present", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    setBearerHeader(null);

    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });
});

describe("requireAuth — MCP-audience tokens have no REST reach", () => {
  // Before the fail-closed default, an MCP-audience token (`health:read`, or
  // `health:read health:write`) was admitted on safe REST methods and refused
  // on writes by the `isMcpAudienceToken` guard. It now carries no `*` grant
  // and no REST route names `health:read`, so the resolver refuses it on EVERY
  // method — reads included. Its audience narrows from "/mcp + REST reads" to
  // "/mcp only", which is what RFC 8707 audience binding asked for.
  //
  // The `isMcpAudienceToken` guard is retained in `lib/auth/guards/caller.ts` as defence
  // in depth; it is unreachable on this path, which is exactly why these tests
  // assert `undeclared_scope` rather than `mcp_audience_write_blocked`.
  const route = apiHandler(async (req) => {
    await requireAuth();
    return Response.json({ ok: true, method: req.method });
  });

  function call(method: string): Promise<Response> {
    setBearerHeader(`Bearer ${RAW_TOKEN}`);
    return route(
      new Request("https://health.example/api/measurements/batch", {
        method,
      }) as never,
    );
  }

  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(FAKE_USER as never);
  });

  function mockMcpToken(permissions: string[]): void {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "mcp-token",
      userId: "user-1",
      permissions,
      revoked: false,
      expiresAt: null,
    } as never);
  }

  for (const permissions of [
    ["health:read"],
    ["health:read", "health:write"],
  ]) {
    const label = permissions.join(" ");

    for (const method of ["GET", "POST", "DELETE"]) {
      it(`refuses a ${label} token on REST ${method} with 403`, async () => {
        mockMcpToken(permissions);
        const res = await call(method);
        expect(res.status).toBe(403);
        expect(auditLog).toHaveBeenCalledWith(
          "auth.bearer.failure",
          expect.objectContaining({
            details: expect.objectContaining({ reason: "undeclared_scope" }),
          }),
        );
      });
    }
  }

  it("does NOT restrict a wildcard token on POST (not MCP-audience)", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "wild",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
    } as never);
    const res = await call("POST");
    expect(res.status).toBe(200);
  });
});

describe("requireAuth — cookie path remains intact", () => {
  it("returns the session payload without consulting the Bearer header", async () => {
    const cookieSession = {
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 3600_000) },
      user: { ...FAKE_USER, role: "USER" as const },
    };
    vi.mocked(getSession).mockResolvedValue(cookieSession as never);
    // Even if a Bearer header is present, the cookie wins (existing behaviour).
    setBearerHeader(`Bearer ${RAW_TOKEN}`);

    const ctx = await requireAuth("medication:ingest");

    // The cookie path carries the session payload plus the derived transport.
    expect(ctx).toEqual({ ...cookieSession, authMethod: "cookie" });
    // Cookie short-circuits before any token logic runs.
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
    expect(hashToken).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});
