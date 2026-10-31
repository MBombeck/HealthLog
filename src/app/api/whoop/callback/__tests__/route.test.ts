import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WhoopProfile } from "@/lib/whoop/wire-types";

// Single-use claiming is covered against Postgres in
// tests/integration/oauth-callback-single-use.test.ts. Here the state row is
// consumed for real against the mocked client, the claim always wins, and
// every callback is the first and only one.
vi.mock("@/lib/oauth/callback-claim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oauth/callback-claim")>()),
  settleOAuthCallback: (_p: string, _s: string, run: () => Promise<unknown>) =>
    run(),
  duplicateOAuthCallback: async () => null,
}));

vi.mock("@/lib/integrations/oauth-kit/connect-target", () => ({
  // The guardian arm is covered in its own test; here the record's own
  // browser (or none) may finish, any other session may not.
  verifyCallbackActor: async (record: string, session: string | null) =>
    session === null || session === record
      ? { ok: true, guardianUserId: null }
      : { ok: false, reason: "cross_user" },
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/db", () => {
  const prisma = {
    whoopOAuthState: { delete: vi.fn() },
    whoopConnection: { findUnique: vi.fn(), upsert: vi.fn() },
    oAuthCallbackClaim: { createMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: async (run: (tx: unknown) => unknown) => run(prisma),
  };
  return { prisma };
});

vi.mock("@/lib/auth/session", () => ({
  // Native ticket path → no web session present.
  getSession: vi.fn(async () => null),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({
    setError: vi.fn(),
    addWarning: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));

vi.mock("@/lib/whoop/client", () => ({
  fetchProfile: vi.fn(async () => ({ user_id: 42 })),
}));
vi.mock("@/lib/whoop/oauth", () => ({
  WHOOP_OAUTH_SCOPE: "read:recovery",
  whoopOAuth: {
    exchange: vi.fn(async () => ({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "read:recovery",
    })),
  },
}));

vi.mock("@/lib/whoop/credentials", () => ({
  getUserWhoopCredentials: vi.fn(async () => ({
    clientId: "cid",
    clientSecret: "secret",
  })),
}));

vi.mock("@/lib/jobs/whoop-backfill", () => ({ WHOOP_BACKFILL_QUEUE: "q" }));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: () => null }));
vi.mock("@/lib/integrations/status", () => ({ markReconnected: vi.fn() }));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { NextRequest } from "next/server";

const stateDelete = prisma.whoopOAuthState.delete as ReturnType<typeof vi.fn>;
const connFindUnique = vi.mocked(prisma.whoopConnection.findUnique);
const connUpsert = prisma.whoopConnection.upsert as ReturnType<typeof vi.fn>;

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function makeReq(nonce: string): NextRequest {
  return {
    url: `https://app.example/api/whoop/callback?code=auth-code&state=${nonce}`,
    cookies: {
      get: (name: string) =>
        name === "whoop_state" ? { value: nonce } : undefined,
    },
  } as unknown as NextRequest;
}

describe("GET /api/whoop/callback custom-scheme redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connFindUnique.mockResolvedValue(null);
    connUpsert.mockResolvedValue({} as never);
  });

  it("redirects to the native custom scheme on success when returnScheme is set", async () => {
    stateDelete.mockResolvedValue({
      userId: "ticket-user",
      expiresAt: new Date(Date.now() + 60_000),
      returnScheme: "dev.healthlog.app",
    });

    const res = await GET(makeReq("nonce-abc"));
    expect(res.headers.get("location")).toBe(
      "dev.healthlog.app://whoop?whoop=connected",
    );
    expect(connUpsert).toHaveBeenCalled();
  });

  it("uses the web redirect on success when no returnScheme", async () => {
    stateDelete.mockResolvedValue({
      userId: "u1",
      expiresAt: new Date(Date.now() + 60_000),
      returnScheme: null,
    });

    const res = await GET(makeReq("nonce-web"));
    expect(res.headers.get("location")).toBe(
      "https://app.example/settings/integrations?whoop=connected",
    );
  });

  it("routes an error to the native scheme when returnScheme is set (expired row)", async () => {
    stateDelete.mockResolvedValue({
      userId: "u1",
      expiresAt: new Date(Date.now() - 1000),
      returnScheme: "dev.healthlog.app",
    });

    const res = await GET(makeReq("nonce-exp"));
    expect(res.headers.get("location")).toBe(
      "dev.healthlog.app://whoop?whoop=error&reason=expired",
    );
    expect(connUpsert).not.toHaveBeenCalled();
  });

  it("pre-resolution CSRF rejection always uses the web redirect", async () => {
    // Cookie/url state mismatch → csrf1, no row consumed.
    const req = {
      url: "https://app.example/api/whoop/callback?code=c&state=URLSTATE",
      cookies: { get: () => ({ value: "DIFFERENT" }) },
    } as unknown as NextRequest;
    const res = await GET(req);
    expect(res.headers.get("location")).toBe(
      "https://app.example/settings/integrations?whoop=error&reason=csrf1",
    );
    expect(stateDelete).not.toHaveBeenCalled();
  });
  it("rejects a WHOOP identity owned by another local user without exposing it", async () => {
    stateDelete.mockResolvedValue({
      userId: "local-user",
      expiresAt: new Date(Date.now() + 60_000),
      returnScheme: null,
    });
    connFindUnique.mockResolvedValue({ userId: "foreign-user" } as never);

    const res = await GET(makeReq("nonce-owner"));

    expect(res.headers.get("location")).toBe(
      "https://app.example/settings/integrations?whoop=error&reason=already_linked",
    );
    expect(res.headers.get("location")).not.toContain("42");
    expect(connUpsert).not.toHaveBeenCalled();
  });

  it("refuses a profile without a user id instead of storing a shared placeholder", async () => {
    stateDelete.mockResolvedValue({
      userId: "u1",
      expiresAt: new Date(Date.now() + 60_000),
      returnScheme: null,
    });
    const { fetchProfile } = await import("@/lib/whoop/client");
    // An off-spec body: the wire type says user_id is always there.
    const offSpec: Partial<WhoopProfile> = {};
    vi.mocked(fetchProfile).mockResolvedValueOnce(offSpec as WhoopProfile);

    const res = await GET(makeReq("nonce-noid"));

    expect(res.headers.get("location")).toBe(
      "https://app.example/settings/integrations?whoop=error&reason=token",
    );
    expect(connFindUnique).not.toHaveBeenCalled();
    expect(connUpsert).not.toHaveBeenCalled();
  });

  it("maps a concurrent WHOOP identity P2002 to the safe owner-conflict redirect", async () => {
    stateDelete.mockResolvedValue({
      userId: "local-user",
      expiresAt: new Date(Date.now() + 60_000),
      returnScheme: "dev.healthlog.app",
    });
    connUpsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["whoop_user_id"] },
      }),
    );

    const res = await GET(makeReq("nonce-race"));

    expect(res.headers.get("location")).toBe(
      "dev.healthlog.app://whoop?whoop=error&reason=already_linked",
    );
    expect(res.headers.get("location")).not.toContain("42");
  });
});
