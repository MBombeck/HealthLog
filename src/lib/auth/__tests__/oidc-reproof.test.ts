/**
 * Confirming at the identity provider (#1296): which accounts are offered it,
 * what the callback accepts as fresh, whose identity counts, and what the
 * sealed state must carry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  findUser: vi.fn<(args: unknown) => Promise<unknown>>(),
  updateSession: vi.fn<(args: unknown) => Promise<unknown>>(),
  countKeys: vi.fn<(args: unknown) => Promise<number>>(),
  countPasskeys: vi.fn<(args: unknown) => Promise<number>>(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: db.findUser },
    session: { update: db.updateSession },
    webauthnMfaCredential: { count: db.countKeys },
    passkey: { count: db.countPasskeys },
  },
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
  refundRateLimit: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((s: string) => s),
  encrypt: vi.fn((s: string) => s),
}));

import { auditLog } from "@/lib/auth/audit";
import { refundRateLimit } from "@/lib/rate-limit";
import {
  isFirstFactorOnlyProof,
  recentProofMethods,
} from "@/lib/auth/second-factor";
import {
  isFreshAuthTime,
  isLinkedIdentity,
  isReproofSession,
  recordOidcReproof,
  reproofReturnUrl,
} from "@/lib/auth/oidc-reproof";
import { readStoredOidcState } from "@/lib/auth/oidc-callback/state";
import { RECENT_PROOF_MAX_AGE_MS } from "@/lib/auth/existing-factor-proof";

const ISSUER = "https://idp.example.test";
const OIDC_ENV = {
  OIDC_ISSUER_URL: ISSUER,
  OIDC_CLIENT_ID: "client",
  OIDC_CLIENT_SECRET: "secret",
};

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    passwordHash: null,
    oidcIssuer: ISSUER,
    oidcSub: "sub-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, OIDC_ENV);
  process.env.NEXT_PUBLIC_APP_URL = "https://healthlog.example.test";
  db.countKeys.mockResolvedValue(0);
  db.countPasskeys.mockResolvedValue(0);
});

afterEach(() => {
  for (const key of Object.keys(OIDC_ENV)) delete process.env[key];
});

describe("recentProofMethods offers the identity provider", () => {
  const user = { id: "u1", totpConfirmedAt: null };

  it("to an account without a second factor whose identity is linked", async () => {
    db.findUser.mockResolvedValue(accountRow());
    expect(await recentProofMethods(user, false)).toEqual(["oidc"]);
  });

  it("beside the password and passkey the account also holds", async () => {
    db.countPasskeys.mockResolvedValue(1);
    db.findUser.mockResolvedValue(accountRow({ passwordHash: "hash" }));
    expect(await recentProofMethods(user, false)).toEqual([
      "password",
      "oidc",
      "passkey",
    ]);
  });

  it("not to an account without a linked identity", async () => {
    db.findUser.mockResolvedValue(
      accountRow({ oidcIssuer: null, oidcSub: null }),
    );
    expect(await recentProofMethods(user, false)).toEqual([]);
  });

  it("not when the instance has no provider configured", async () => {
    delete process.env.OIDC_CLIENT_SECRET;
    db.findUser.mockResolvedValue(accountRow());
    expect(await recentProofMethods(user, false)).toEqual([]);
  });

  it("not to an account with a second factor, where it could not clear the gate", async () => {
    db.countKeys.mockResolvedValue(1);
    db.findUser.mockResolvedValue(accountRow());
    expect(await recentProofMethods(user, true)).toEqual(["webauthn"]);
  });

  it("and never counts it as a second factor", () => {
    expect(isFirstFactorOnlyProof("oidc")).toBe(true);
    expect(isFirstFactorOnlyProof("password")).toBe(true);
    expect(isFirstFactorOnlyProof("passkey")).toBe(false);
  });
});

describe("isFreshAuthTime", () => {
  const now = 1_800_000_000_000;
  const seconds = (ms: number) => Math.floor(ms / 1000);

  it("accepts an authentication inside the five-minute window", () => {
    expect(isFreshAuthTime(seconds(now - 10_000), now)).toBe(true);
    expect(isFreshAuthTime(seconds(now - 300_000), now)).toBe(true);
  });

  it("refuses one older than the window", () => {
    expect(isFreshAuthTime(seconds(now - 301_000), now)).toBe(false);
    expect(isFreshAuthTime(seconds(now - 3_600_000), now)).toBe(false);
  });

  it("refuses a token that does not say when", () => {
    expect(isFreshAuthTime(null, now)).toBe(false);
  });

  it("tolerates a provider clock a minute ahead, and no more", () => {
    expect(isFreshAuthTime(seconds(now + 30_000), now)).toBe(true);
    expect(isFreshAuthTime(seconds(now + 120_000), now)).toBe(false);
  });
});

describe("isLinkedIdentity", () => {
  it("needs both the issuer and the subject to match", () => {
    const account = { oidcIssuer: ISSUER, oidcSub: "sub-1" };
    expect(isLinkedIdentity(account, ISSUER, "sub-1")).toBe(true);
    expect(isLinkedIdentity(account, ISSUER, "sub-2")).toBe(false);
    expect(isLinkedIdentity(account, "https://other.test", "sub-1")).toBe(
      false,
    );
    expect(
      isLinkedIdentity({ oidcIssuer: null, oidcSub: null }, ISSUER, "sub-1"),
    ).toBe(false);
  });
});

describe("isReproofSession", () => {
  const bound = { reproofUserId: "u1", reproofSessionId: "s1" };

  it("holds only for the session and account the start bound", () => {
    expect(
      isReproofSession(bound, { session: { id: "s1" }, user: { id: "u1" } }),
    ).toBe(true);
    expect(
      isReproofSession(bound, { session: { id: "s2" }, user: { id: "u1" } }),
    ).toBe(false);
    expect(
      isReproofSession(bound, { session: { id: "s1" }, user: { id: "u2" } }),
    ).toBe(false);
    expect(isReproofSession(bound, null)).toBe(false);
    expect(
      isReproofSession({}, { session: { id: "s1" }, user: { id: "u1" } }),
    ).toBe(false);
  });
});

describe("recordOidcReproof", () => {
  const now = 1_800_000_000_000;
  const args = {
    userId: "u1",
    sessionId: "s1",
    issuer: ISSUER,
    ipAddress: "203.0.113.5",
    nowMs: now,
  };

  it("stamps reproofAt only, refunds the attempt and audits the success", async () => {
    db.findUser.mockResolvedValue(accountRow());
    const outcome = await recordOidcReproof({
      ...args,
      identity: { sub: "sub-1", authTime: Math.floor(now / 1000) - 5 },
    });
    expect(outcome).toEqual({ ok: true });
    // Stamped at the authentication, not at the callback.
    expect(db.updateSession).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { reproofAt: new Date((Math.floor(now / 1000) - 5) * 1000) },
    });
    expect(refundRateLimit).toHaveBeenCalledWith("auth:step-up:u1");
    expect(auditLog).toHaveBeenCalledWith(
      "auth.reproof.succeeded",
      expect.objectContaining({ details: { method: "oidc" } }),
    );
  });

  it("runs the window from the authentication, so a token near its end buys no extra minutes", async () => {
    db.findUser.mockResolvedValue(accountRow());
    const authTime = Math.floor(now / 1000) - 4 * 60;
    await recordOidcReproof({ ...args, identity: { sub: "sub-1", authTime } });
    const [call] = db.updateSession.mock.calls[0] as [
      { data: { reproofAt: Date } },
    ];
    const stamped = call.data.reproofAt;
    expect(stamped.getTime()).toBe(authTime * 1000);
    // Two minutes after the callback the proof is six minutes old: past the
    // window every recent-proof gate applies.
    expect(now + 2 * 60_000 - stamped.getTime()).toBeGreaterThan(
      RECENT_PROOF_MAX_AGE_MS,
    );
  });

  it("never stamps a proof in the future for a provider clock a little ahead", async () => {
    db.findUser.mockResolvedValue(accountRow());
    await recordOidcReproof({
      ...args,
      identity: { sub: "sub-1", authTime: Math.floor(now / 1000) + 30 },
    });
    expect(db.updateSession).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { reproofAt: new Date(now) },
    });
  });

  it("refuses a stale auth_time without stamping", async () => {
    db.findUser.mockResolvedValue(accountRow());
    const outcome = await recordOidcReproof({
      ...args,
      identity: { sub: "sub-1", authTime: Math.floor(now / 1000) - 3600 },
    });
    expect(outcome).toEqual({ ok: false, reason: "stale_auth_time" });
    expect(db.updateSession).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      "auth.mfa.failed",
      expect.objectContaining({
        details: {
          stage: "oidc_reproof",
          method: "oidc",
          reason: "stale_auth_time",
        },
      }),
    );
  });

  it("refuses a different subject without stamping", async () => {
    db.findUser.mockResolvedValue(accountRow());
    const outcome = await recordOidcReproof({
      ...args,
      identity: { sub: "someone-else", authTime: Math.floor(now / 1000) },
    });
    expect(outcome).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(db.updateSession).not.toHaveBeenCalled();
  });
});

describe("the re-proof return and state", () => {
  it("returns to the page it left with the outcome attached", () => {
    const url = reproofReturnUrl("/settings/api?tab=mcp", "done");
    expect(url.origin).toBe("https://healthlog.example.test");
    expect(url.pathname).toBe("/settings/api");
    expect(url.searchParams.get("tab")).toBe("mcp");
    expect(url.searchParams.get("reproof")).toBe("done");
  });

  it("reads a reproof state only with both bindings and no other intent's fields", () => {
    const base = { state: "s", nonce: "n", codeVerifier: "v", next: "/" };
    const ok = readStoredOidcState(
      JSON.stringify({
        ...base,
        intent: "reproof",
        reproofUserId: "u1",
        reproofSessionId: "s1",
      }),
    );
    expect(ok?.intent).toBe("reproof");
    expect(
      readStoredOidcState(
        JSON.stringify({ ...base, intent: "reproof", reproofUserId: "u1" }),
      ),
    ).toBeNull();
    expect(
      readStoredOidcState(
        JSON.stringify({
          ...base,
          intent: "reproof",
          reproofUserId: "u1",
          reproofSessionId: "s1",
          native: true,
          appCodeChallenge: "c",
        }),
      ),
    ).toBeNull();
    expect(
      readStoredOidcState(JSON.stringify({ ...base, intent: "other" })),
    ).toBeNull();
  });
});
