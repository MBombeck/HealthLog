import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  stateMatchesCookieMock,
  verifySignedStateMock,
  getSessionMock,
  exchangeCodeMock,
  registerUserMock,
  getCredsMock,
  markReconnectedMock,
  bossSend,
  bossMock,
} = vi.hoisted(() => ({
  stateMatchesCookieMock: vi.fn(),
  verifySignedStateMock: vi.fn(),
  getSessionMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  registerUserMock: vi.fn(),
  getCredsMock: vi.fn(),
  markReconnectedMock: vi.fn(),
  bossSend: vi.fn(),
  bossMock: vi.fn(),
}));

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
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({
    setAuth: vi.fn(),
    setError: vi.fn(),
    addWarning: vi.fn(),
  }),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: getSessionMock }));
vi.mock("@/lib/polar/client", () => ({
  registerUser: registerUserMock,
}));
vi.mock("@/lib/polar/oauth", () => ({
  polarOAuth: { exchange: exchangeCodeMock },
}));
vi.mock("@/lib/polar/credentials", () => ({
  getPolarClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  oauthStateCookieName: () => "polar_oauth_state",
  stateMatchesCookie: stateMatchesCookieMock,
  verifySignedState: verifySignedStateMock,
}));
vi.mock("@/lib/integrations/status", () => ({
  markReconnected: markReconnectedMock,
}));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: bossMock }));

import { GET } from "../route";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function makeReq(query = "code=abc&state=s"): Parameters<typeof GET>[0] {
  return {
    url: `https://app.example/api/polar/callback?${query}`,
    cookies: { get: () => ({ value: "s" }) },
  } as unknown as Parameters<typeof GET>[0];
}

const run = GET as unknown as (req: ReturnType<typeof makeReq>) => Promise<{
  status: number;
  headers: { get(k: string): string | null };
}>;

beforeEach(() => {
  vi.clearAllMocks();
  stateMatchesCookieMock.mockReturnValue(true);
  verifySignedStateMock.mockReturnValue({ userId: "u1" });
  getSessionMock.mockResolvedValue(null);
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
  exchangeCodeMock.mockResolvedValue({ access_token: "tok", x_user_id: 42 });
  bossSend.mockResolvedValue("job-1");
  bossMock.mockReturnValue({ send: bossSend });
  registerUserMock.mockResolvedValue(undefined);
});

describe("GET /api/polar/callback", () => {
  it("completes the handshake and redirects to connected", async () => {
    const res = await run(makeReq());
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("polar=connected");
    expect(markReconnectedMock).toHaveBeenCalledWith("u1", "polar");
  });

  it("refuses a Polar member another record already holds, before registering it", async () => {
    const { prisma } = await import("@/lib/db");
    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      { id: "guardian-1", polarUserIdEncrypted: "enc:42" },
    ] as never);
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=already_linked");
    expect(registerUserMock).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a CSRF cookie/param mismatch before exchanging the code", async () => {
    stateMatchesCookieMock.mockReturnValue(false);
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=csrf1");
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-user session completing another user's handshake", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "other" } });
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=cross_user");
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });

  it("rejects an off-spec token body missing x_user_id", async () => {
    exchangeCodeMock.mockResolvedValue({ access_token: "tok" });
    const res = await run(makeReq());
    expect(res.headers.get("location")).toContain("reason=token");
    expect(registerUserMock).not.toHaveBeenCalled();
  });
});

/**
 * v1.32.28 — connecting starts a sync straight away instead of leaving the card
 * empty until the next hourly tick. The poll handler has accepted a single-user
 * payload since it was written; this callback is the producer that was missing.
 */
describe("GET /api/polar/callback — connect-time first sync", () => {
  it("enqueues exactly one targeted polar-sync job for the connecting user", async () => {
    const res = await run(makeReq());

    expect(res.headers.get("location")).toContain("polar=connected");
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith("polar-sync", { userId: "u1" });
  });

  it("still connects when no boss instance is available", async () => {
    bossMock.mockReturnValue(null);

    const res = await run(makeReq());

    expect(res.headers.get("location")).toContain("polar=connected");
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("still connects when the enqueue itself rejects", async () => {
    bossSend.mockRejectedValue(new Error("queue unreachable"));

    const res = await run(makeReq());

    expect(res.headers.get("location")).toContain("polar=connected");
  });
});

describe("GET /api/polar/callback — claim only what can be exchanged", () => {
  it("does not claim the state for a callback without a code or for another user", async () => {
    const denied = await run(makeReq("state=s&error=access_denied"));
    expect(denied.headers.get("location")).toContain("reason=nocode");
    getSessionMock.mockResolvedValue({ user: { id: "other" } });
    await run(makeReq());
    expect(claimSpy).not.toHaveBeenCalled();
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });
});
