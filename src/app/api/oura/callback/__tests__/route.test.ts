import { describe, it, expect, vi, beforeEach } from "vitest";

// Single-use claiming is covered against Postgres in
// tests/integration/oauth-callback-single-use.test.ts; here every callback
// is the first and only one.
const { claimSpy } = vi.hoisted(() => ({ claimSpy: vi.fn() }));
vi.mock("@/lib/oauth/callback-claim", () => ({
  runOAuthCallbackOnce: (
    _p: string,
    _s: string,
    _o: unknown,
    run: () => Promise<unknown>,
  ) => {
    claimSpy();
    return run();
  },
  settleOAuthCallback: (_p: string, _s: string, run: () => Promise<unknown>) =>
    run(),
  consumeLedgerState: async (
    _p: string,
    _s: string,
    consume: (tx: unknown) => Promise<unknown>,
  ) => consume((await import("@/lib/db")).prisma),
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

vi.mock("@/lib/db", () => ({
  prisma: { user: { update: vi.fn(), findMany: vi.fn(async () => []) } },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({
    setError: vi.fn(),
    setAuth: vi.fn(),
    addWarning: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/integrations/status", () => ({ markReconnected: vi.fn() }));

const {
  exchangeMock,
  getCredsMock,
  matchMock,
  verifyMock,
  bossSend,
  bossMock,
} = vi.hoisted(() => ({
  exchangeMock: vi.fn(),
  getCredsMock: vi.fn(),
  matchMock: vi.fn(),
  verifyMock: vi.fn(),
  bossSend: vi.fn(),
  bossMock: vi.fn(),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: bossMock }));

vi.mock("@/lib/oura/client", () => ({
  fetchOuraAccountId: vi.fn(async () => "oura-account-1"),
}));
vi.mock("@/lib/oura/oauth", async (importOriginal) => ({
  isAcceptedOuraIssuer: (
    await importOriginal<typeof import("@/lib/oura/oauth")>()
  ).isAcceptedOuraIssuer,
  exchangeOuraCode: exchangeMock,
}));
vi.mock("@/lib/oura/credentials", () => ({
  getOuraClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  oauthStateCookieName: (p: string) => `${p}_state`,
  stateMatchesCookie: matchMock,
  verifySignedState: verifyMock,
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import type { NextRequest } from "next/server";

const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function makeReq(opts: {
  code?: string;
  state?: string;
  cookie?: string;
  iss?: string;
}): NextRequest {
  const params = new URLSearchParams();
  if (opts.code) params.set("code", opts.code);
  if (opts.state) params.set("state", opts.state);
  if (opts.iss) params.set("iss", opts.iss);
  return {
    url: `https://app.example/api/oura/callback?${params}`,
    cookies: {
      get: (name: string) =>
        name === "oura_state" && opts.cookie
          ? { value: opts.cookie }
          : undefined,
    },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  matchMock.mockReturnValue(true);
  verifyMock.mockReturnValue({ userId: "u1" });
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
  exchangeMock.mockResolvedValue({ access_token: "at", refresh_token: "rt" });
  userUpdate.mockResolvedValue({});
  (getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  bossSend.mockResolvedValue("job-1");
  bossMock.mockReturnValue({ send: bossSend });
});

describe("GET /api/oura/callback", () => {
  it("rejects a cookie/state mismatch as csrf1 before any exchange", async () => {
    matchMock.mockReturnValue(false);
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "X" }));
    expect(res.headers.get("location")).toContain("reason=csrf1");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable signed state", async () => {
    verifyMock.mockReturnValue(null);
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=state");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("rejects when the verified userId mismatches a live session (cross_user)", async () => {
    (getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "attacker" },
    });
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=cross_user");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("falls back to nocreds when no BYO/env credentials resolve", async () => {
    getCredsMock.mockResolvedValue(null);
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=nocreds");
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it("exchanges the code, persists encrypted tokens, and audits on success", async () => {
    const res = await GET(
      makeReq({ code: "auth-code", state: "S", cookie: "S" }),
    );
    expect(exchangeMock).toHaveBeenCalledWith(
      "auth-code",
      { clientId: "c", clientSecret: "s" },
      null,
    );
    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.ouraAccessTokenEncrypted).toBe("enc:at");
    expect(data.ouraRefreshTokenEncrypted).toBe("enc:rt");
    expect(auditLog).toHaveBeenCalledWith("oura.connect", {
      userId: "u1",
      actorUserId: null,
    });
    expect(data.ouraUserId).toBe("oura-account-1");
    expect(res.headers.get("location")).toContain("oura=connected");
  });

  it("refuses an Oura account another record already holds", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "guardian-1" },
    ] as never);
    const res = await GET(
      makeReq({ code: "auth-code", state: "S", cookie: "S" }),
    );
    expect(res.headers.get("location")).toContain("reason=already_linked");
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ouraUserId: "oura-account-1", id: { not: "u1" } },
      }),
    );
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

// Oura's current authorization server names itself on the callback
// (RFC 9207); the issuer travels on to pick the token endpoint.
describe("GET /api/oura/callback — issuer", () => {
  it("passes Oura's issuer on to the code exchange", async () => {
    const iss = "https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous";
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S", iss }));
    expect(exchangeMock).toHaveBeenCalledWith(
      "c",
      { clientId: "c", clientSecret: "s" },
      iss,
    );
    expect(res.headers.get("location")).toContain("oura=connected");
  });

  it("refuses a callback that names a foreign authorization server", async () => {
    const res = await GET(
      makeReq({
        code: "c",
        state: "S",
        cookie: "S",
        iss: "https://evil.example/oauth",
      }),
    );
    expect(res.headers.get("location")).toContain("reason=issuer");
    expect(exchangeMock).not.toHaveBeenCalled();
  });
});

/**
 * v1.32.28 — connecting starts a sync straight away. The poll handler has
 * accepted a single-user payload since it was written; this callback is the
 * producer that was missing, and without it a fresh connection showed an empty
 * card for up to an hour.
 */
describe("GET /api/oura/callback — connect-time first sync", () => {
  it("enqueues one targeted oura-sync job and the history backfill for the connecting user", async () => {
    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));

    expect(res.headers.get("location")).toContain("oura=connected");
    expect(bossSend).toHaveBeenCalledTimes(2);
    expect(bossSend).toHaveBeenCalledWith("oura-sync", { userId: "u1" });
    expect(bossSend).toHaveBeenCalledWith(
      "oura-backfill",
      expect.objectContaining({ userId: "u1" }),
      expect.objectContaining({ singletonKey: "oura-backfill|u1" }),
    );
  });

  it("still connects when no boss instance is available", async () => {
    bossMock.mockReturnValue(null);

    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));

    expect(res.headers.get("location")).toContain("oura=connected");
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still connects when the enqueue itself rejects", async () => {
    bossSend.mockRejectedValue(new Error("queue unreachable"));

    const res = await GET(makeReq({ code: "c", state: "S", cookie: "S" }));

    expect(res.headers.get("location")).toContain("oura=connected");
  });
});

// A refused callback must not spend the state: Oura sends a denied consent
// back without a code, and the person may return to the same authorize URL
// and allow it.
describe("GET /api/oura/callback — claim only what can be exchanged", () => {
  it("does not claim the state for a callback without a code", async () => {
    const res = await GET(makeReq({ state: "S", cookie: "S" }));
    expect(res.headers.get("location")).toContain("reason=nocode");
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("does not claim the state for a foreign issuer or a cross-user session", async () => {
    await GET(
      makeReq({
        code: "c",
        state: "S",
        cookie: "S",
        iss: "https://evil.example/oauth",
      }),
    );
    (getSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "attacker" },
    });
    await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("claims the state once before exchanging a valid code", async () => {
    await GET(makeReq({ code: "c", state: "S", cookie: "S" }));
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(exchangeMock).toHaveBeenCalledTimes(1);
  });
});
