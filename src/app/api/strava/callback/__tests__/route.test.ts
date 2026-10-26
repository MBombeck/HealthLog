/**
 * S-1 — the Strava OAuth callback enqueues the self-converging history backfill
 * at connect time (mirroring the WHOOP / Fitbit callbacks) so deep history
 * lands within the hour instead of waiting for the next worker reboot. A missing
 * boss instance is a warning, never a failure — boot discovery is the net.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  bossSend,
  getGlobalBossMock,
  exchangeCodeMock,
  getCredsMock,
  userFindUnique,
  userFindMany,
  userUpdate,
  markReconnectedMock,
} = vi.hoisted(() => ({
  bossSend: vi.fn(async () => "job-id"),
  getGlobalBossMock: vi.fn(),
  exchangeCodeMock: vi.fn(),
  getCredsMock: vi.fn(),
  userFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userUpdate: vi.fn(async () => ({})),
  markReconnectedMock: vi.fn(async () => {}),
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
  prisma: {
    user: {
      findUnique: userFindUnique,
      findMany: userFindMany,
      update: userUpdate,
    },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn(async () => null) }));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({
    setAuth: vi.fn(),
    setError: vi.fn(),
    addWarning: vi.fn(),
  }),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc(${s})` }));
vi.mock("@/lib/strava/oauth", () => ({
  stravaOAuth: { exchange: exchangeCodeMock },
}));
vi.mock("@/lib/strava/credentials", () => ({
  getStravaClientCredentials: getCredsMock,
}));
vi.mock("@/lib/oauth/signed-state", () => ({
  oauthStateCookieName: () => "strava_oauth_state",
  stateMatchesCookie: () => true,
  verifySignedState: () => ({ userId: "u1" }),
}));
vi.mock("@/lib/integrations/status", () => ({
  markReconnected: markReconnectedMock,
}));
vi.mock("@/lib/jobs/strava-backfill", () => ({
  STRAVA_BACKFILL_QUEUE: "strava-backfill",
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: getGlobalBossMock,
}));

import { GET } from "../route";

process.env.NEXT_PUBLIC_APP_URL = "https://app.example";

function callback(
  query = "code=abc&state=signed-state",
): Promise<{ headers: { get(k: string): string | null } }> {
  const req = new NextRequest(`http://localhost/api/strava/callback?${query}`, {
    headers: { cookie: "strava_oauth_state=signed-state" },
  });
  return (GET as unknown as (r: NextRequest) => Promise<never>)(req);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCredsMock.mockResolvedValue({ clientId: "c", clientSecret: "s" });
  exchangeCodeMock.mockResolvedValue({
    access_token: "at",
    refresh_token: "rt",
    athlete: { id: 42 },
  });
  userFindUnique.mockResolvedValue({ stravaAthleteId: null });
  userFindMany.mockResolvedValue([]);
  getGlobalBossMock.mockReturnValue({ send: bossSend });
});

describe("GET /api/strava/callback — S-1 backfill enqueue", () => {
  it("enqueues one STRAVA_BACKFILL_QUEUE job for the connecting user", async () => {
    const res = await callback();

    expect(res.headers.get("location")).toContain("strava=connected");
    expect(markReconnectedMock).toHaveBeenCalledWith("u1", "strava");
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith(
      "strava-backfill",
      expect.objectContaining({ userId: "u1" }),
    );
  });

  it("still connects when the boss instance is unavailable (warning, not failure)", async () => {
    getGlobalBossMock.mockReturnValue(null);

    const res = await callback();

    expect(res.headers.get("location")).toContain("strava=connected");
    expect(bossSend).not.toHaveBeenCalled();
  });
});

describe("GET /api/strava/callback — one athlete, one record", () => {
  it("refuses an athlete another record already holds", async () => {
    userFindMany.mockResolvedValueOnce([{ id: "guardian-1" }]);

    const res = await callback();

    expect(res.headers.get("location")).toContain("reason=already_linked");
    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stravaAthleteId: "42", id: { not: "u1" } },
      }),
    );
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("GET /api/strava/callback — claim only what can be exchanged", () => {
  it("does not claim the state for a callback without a code", async () => {
    const res = await callback("state=signed-state&error=access_denied");
    expect(res.headers.get("location")).toContain("reason=nocode");
    expect(claimSpy).not.toHaveBeenCalled();
    expect(exchangeCodeMock).not.toHaveBeenCalled();
  });
});
