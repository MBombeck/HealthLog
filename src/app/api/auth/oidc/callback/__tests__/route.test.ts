import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ setError: vi.fn() }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((s: string) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
  encrypt: vi.fn((s: string) => `enc(${s})`),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    appSettings: { findUnique: vi.fn() },
    webauthnMfaCredential: { count: vi.fn() },
    // v1.28.48 — the first-admin provision count+insert now runs inside a
    // transaction-scoped advisory lock. Default `$transaction` to run the
    // callback with the same prisma mock as its `tx` handle.
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn(),
  validateSessionFromCookieValue: vi.fn(),
}));
vi.mock("@/lib/auth/login-alert", () => ({ recordSignInDevice: vi.fn() }));
vi.mock("@/lib/auth/mfa/challenge", () => ({
  createMfaChallenge: vi.fn(async () => ({
    ticket: "mfa-ticket-1",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  })),
}));
vi.mock("@/lib/auth/mfa-enrollment", () => ({
  syncMfaEnrollCookie: vi.fn(),
}));
vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => false,
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveServerDefaultTimezone: vi.fn(async () => "Europe/Berlin"),
}));

vi.mock("@/lib/auth/oidc", () => ({
  getOidcConfig: vi.fn(),
  discoverOidcMetadata: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  verifyIdToken: vi.fn(),
  fetchUserinfoEmail: vi.fn(),
  getOidcRedirectUri: () =>
    "https://healthlog.example.com/api/auth/oidc/callback",
  oidcAppUrl: (path: string) => new URL(path, "https://healthlog.example.com"),
  deriveUniqueUsername: vi.fn(async (email: string) => email.split("@")[0]),
}));

// The handoff lib is unit-tested separately; here we assert the callback
// branches into it and redirects to the custom scheme (real
// `buildNativeCallbackUrl`, mocked `mintNativeHandoff`).
vi.mock("@/lib/auth/oidc-native-handoff", () => ({
  buildNativeCallbackUrl: (params: Record<string, string>) =>
    `healthlog://oidc-callback?${new URLSearchParams(params).toString()}`,
  mintNativeHandoff: vi.fn(async () => ({
    code: "hlh_test_code",
    handoffId: "ho-1",
  })),
}));

import { GET } from "../route";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import {
  createSession,
  validateSessionFromCookieValue,
} from "@/lib/auth/session";
import { createMfaChallenge } from "@/lib/auth/mfa/challenge";
import {
  getOidcConfig,
  discoverOidcMetadata,
  exchangeCodeForTokens,
  verifyIdToken,
} from "@/lib/auth/oidc";
import { mintNativeHandoff } from "@/lib/auth/oidc-native-handoff";
import { fixtureSessionSecret } from "@/__tests__/helpers/session-secret";

const CONFIG = {
  issuerUrl: "https://idp.example.com",
  clientId: "client-1",
  clientSecret: "secret-1",
  scopes: "openid email profile",
  buttonLabel: "SSO",
};
const METADATA = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
};

/** A minimal user row shaped like what the callback consumes. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "existing@example.com",
    onboardingCompletedAt: new Date(),
    oidcIssuer: null,
    oidcSub: null,
    totpConfirmedAt: null,
    mfaEnforced: false,
    ...overrides,
  };
}

/**
 * The callback's `prisma.user.findFirst` calls are distinguishable by
 * their `where` shape: the (issuer, sub) identity lookup, the display-
 * email collision probe (`NOT`), and the link/provision email match.
 */
function mockUserLookups(opts: {
  byIdentity?: ReturnType<typeof userRow> | null;
  byEmail?: ReturnType<typeof userRow> | null;
  emailTaken?: boolean;
}) {
  vi.mocked(prisma.user.findFirst).mockImplementation(((args: {
    where: Record<string, unknown>;
  }) => {
    if (args.where.oidcIssuer !== undefined) {
      return Promise.resolve(opts.byIdentity ?? null);
    }
    if (args.where.NOT !== undefined) {
      return Promise.resolve(opts.emailTaken ? { id: "user-other" } : null);
    }
    return Promise.resolve(opts.byEmail ?? null);
  }) as never);
}

function makeRequest(opts: { query?: string; cookie?: string }): NextRequest {
  const req = new NextRequest(
    `http://localhost/api/auth/oidc/callback${opts.query ?? ""}`,
  );
  if (opts.cookie) {
    req.cookies.set("oidc_auth_state", opts.cookie);
  }
  return req;
}

function stateCookie(payload: Record<string, unknown>): string {
  return `enc(${JSON.stringify(payload)})`;
}

/** A request whose query/state pass the CSRF gate — the default fixture. */
function validRequest(next = "/"): NextRequest {
  return makeRequest({
    query: "?code=abc&state=STATE",
    cookie: stateCookie({
      state: "STATE",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      next,
    }),
  });
}

function mockIdentity(overrides: Record<string, unknown> = {}) {
  vi.mocked(exchangeCodeForTokens).mockResolvedValue({ id_token: "idt" });
  vi.mocked(verifyIdToken).mockResolvedValue({
    sub: "sub-1",
    email: "existing@example.com",
    emailVerified: true,
    name: null,
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 20,
    reset: 0,
    ip: "1.2.3.4",
  } as never);
  vi.mocked(getOidcConfig).mockReturnValue(CONFIG);
  vi.mocked(discoverOidcMetadata).mockResolvedValue(METADATA);
  vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0);
  vi.mocked(createMfaChallenge).mockResolvedValue({
    ticket: "mfa-ticket-1",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  // Run the provision transaction callback against the same prisma mock as
  // its `tx` handle, and let the advisory-lock `$queryRaw` resolve.
  vi.mocked(prisma.$transaction).mockImplementation(((
    fn: (tx: typeof prisma) => unknown,
  ) => fn(prisma)) as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([{ locked: 1 }] as never);
});

describe("GET /api/auth/oidc/callback", () => {
  it("redirects with oidc_denied when the IdP reports an error", async () => {
    const res = await GET(makeRequest({ query: "?error=access_denied" }));
    expect(res.headers.get("location")).toContain("error=oidc_denied");
  });

  it("redirects with oidc_state when code/state are missing", async () => {
    const res = await GET(makeRequest({}));
    expect(res.headers.get("location")).toContain("error=oidc_state");
  });

  it("redirects with oidc_state when the state cookie is missing", async () => {
    const res = await GET(makeRequest({ query: "?code=abc&state=xyz" }));
    expect(res.headers.get("location")).toContain("error=oidc_state");
  });

  it("redirects with oidc_state on a state/cookie mismatch (CSRF)", async () => {
    const res = await GET(
      makeRequest({
        query: "?code=abc&state=WRONG",
        cookie: stateCookie({
          state: "RIGHT",
          nonce: "nonce-1",
          codeVerifier: "verifier-1",
          next: "/",
        }),
      }),
    );
    expect(res.headers.get("location")).toContain("error=oidc_state");
  });

  it("redirects with oidc_no_email when the identity has no email at all", async () => {
    mockIdentity({ email: null, emailVerified: undefined });
    mockUserLookups({ byIdentity: null });
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain("error=oidc_no_email");
  });

  it("redirects with oidc_email_unverified when email_verified is absent", async () => {
    // An IdP that never asserts verification cannot anchor a link or a
    // provision — absent is a reject, not a benefit of the doubt.
    mockIdentity({ emailVerified: undefined });
    mockUserLookups({ byIdentity: null, byEmail: null });
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain(
      "error=oidc_email_unverified",
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("redirects with oidc_email_unverified when email_verified is false", async () => {
    mockIdentity({ emailVerified: false });
    mockUserLookups({ byIdentity: null, byEmail: null });
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain(
      "error=oidc_email_unverified",
    );
  });

  it("logs in by (issuer, sub) without consulting the email", async () => {
    // Even with a brand-new email at the IdP, the stamped identity wins —
    // no second account is provisioned and no re-link happens.
    mockIdentity({ email: "renamed@example.com", emailVerified: true });
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
      }),
      emailTaken: false,
    });
    vi.mocked(prisma.user.update).mockResolvedValue(
      userRow({
        email: "renamed@example.com",
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
      }) as never,
    );

    const res = await GET(validRequest("/dashboard"));

    expect(prisma.user.create).not.toHaveBeenCalled();
    // Display email refresh — the only field the update touches.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { email: "renamed@example.com" },
    });
    expect(createSession).toHaveBeenCalled();
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("skips the display-email refresh when another account holds the address", async () => {
    mockIdentity({ email: "collide@example.com", emailVerified: true });
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
      }),
      emailTaken: true,
    });

    const res = await GET(validRequest());

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalled();
    expect(res.status).toBe(307);
  });

  // Inverted in v1.39.3. This used to pin the auto-link: an existing account
  // with the same (unverified) local email was bound on the spot and signed
  // in. Whoever set that address first owned the account the SSO user landed
  // in, so the callback now links nothing and signs nobody in; it leaves a
  // sealed pending link and sends the browser to confirm the account with its
  // own credential (`oidc-pending-link.test.ts` covers the completion).
  it("does not link an email-matched account on the email alone", async () => {
    mockIdentity();
    mockUserLookups({ byIdentity: null, byEmail: userRow() });

    const res = await GET(validRequest("/dashboard"));

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalledWith(
      "auth.oidc.linked",
      expect.anything(),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "auth.oidc.link_pending",
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(res.headers.get("location")).toContain("error=oidc_link_required");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hl_oidc_link=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).toContain("Path=/api/auth");
  });

  it("rejects a login whose email matches an account bound to a DIFFERENT identity", async () => {
    mockIdentity({ sub: "sub-intruder" });
    mockUserLookups({
      byIdentity: null,
      byEmail: userRow({
        oidcIssuer: "https://other-idp.example.com",
        oidcSub: "sub-original",
      }),
    });

    const res = await GET(validRequest());

    expect(res.headers.get("location")).toContain(
      "error=oidc_identity_conflict",
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      "auth.oidc.link_conflict",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("auto-provisions a new user when registration is open", async () => {
    mockIdentity({
      sub: "sub-2",
      email: "New@Example.com",
      emailVerified: true,
    });
    mockUserLookups({ byIdentity: null, byEmail: null });
    vi.mocked(prisma.user.count).mockResolvedValue(3);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: true,
    } as never);
    vi.mocked(prisma.user.create).mockResolvedValue(
      userRow({ id: "user-new", onboardingCompletedAt: null }) as never,
    );

    const res = await GET(validRequest());

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          // Lowercased at provision time; stamped with the durable identity
          // and the same server-default timezone the register route resolves.
          email: "new@example.com",
          passwordHash: null,
          role: "USER",
          timezone: "Europe/Berlin",
          oidcIssuer: METADATA.issuer,
          oidcSub: "sub-2",
        }),
      }),
    );
    expect(createSession).toHaveBeenCalled();
    expect(res.status).toBe(307);
  });

  it("mints ADMIN for a genuine first OIDC user (in-lock count 0)", async () => {
    mockIdentity({
      sub: "sub-first",
      email: "first@example.com",
      emailVerified: true,
    });
    mockUserLookups({ byIdentity: null, byEmail: null });
    // Both the outer registration gate and the in-lock re-count observe an
    // empty DB → the provisioned account is the operator's first ADMIN.
    vi.mocked(prisma.user.count).mockResolvedValue(0);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: true,
    } as never);
    vi.mocked(prisma.user.create).mockResolvedValue(
      userRow({ id: "user-new", onboardingCompletedAt: null }) as never,
    );

    const res = await GET(validRequest());

    const createArgs = vi.mocked(prisma.user.create).mock.calls[0]?.[0] as {
      data: { role: string };
    };
    expect(createArgs.data.role).toBe("ADMIN");
    expect(createSession).toHaveBeenCalled();
    expect(res.status).toBe(307);
  });

  it("mints USER when a concurrent first user committed first (stale outer read 0, in-lock re-count 1)", async () => {
    // The outer read observed the empty-DB window (0), but by the time the
    // advisory-locked transaction re-counts, the racing first provision has
    // committed → 1. Without the in-lock re-count this second user would also
    // be minted ADMIN (the double-admin bug); the fresh count closes it. The
    // shared lock key also serialises this against a racing password register.
    mockIdentity({
      sub: "sub-second",
      email: "second@example.com",
      emailVerified: true,
    });
    mockUserLookups({ byIdentity: null, byEmail: null });
    vi.mocked(prisma.user.count)
      .mockResolvedValueOnce(0) // outer registrationEnabled gate
      .mockResolvedValueOnce(1); // inside the advisory-locked transaction
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: true,
    } as never);
    vi.mocked(prisma.user.create).mockResolvedValue(
      userRow({ id: "user-new", onboardingCompletedAt: null }) as never,
    );

    const res = await GET(validRequest());

    const createArgs = vi.mocked(prisma.user.create).mock.calls[0]?.[0] as {
      data: { role: string };
    };
    expect(createArgs.data.role).toBe("USER");
    expect(res.status).toBe(307);
  });

  it("acquires the transaction-scoped advisory lock before provisioning", async () => {
    mockIdentity({
      sub: "sub-lock",
      email: "lock@example.com",
      emailVerified: true,
    });
    mockUserLookups({ byIdentity: null, byEmail: null });
    vi.mocked(prisma.user.count).mockResolvedValue(0);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: true,
    } as never);
    vi.mocked(prisma.user.create).mockResolvedValue(
      userRow({ id: "user-new", onboardingCompletedAt: null }) as never,
    );

    await GET(validRequest());

    // The lock (`$queryRaw` on `pg_advisory_xact_lock`) runs inside the
    // `$transaction`, and the create is gated behind both.
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(
      vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(prisma.user.create).mock.invocationCallOrder[0]);
  });

  it("refuses to auto-provision when registration is closed", async () => {
    mockIdentity({ sub: "sub-3", email: "blocked@example.com" });
    mockUserLookups({ byIdentity: null, byEmail: null });
    vi.mocked(prisma.user.count).mockResolvedValue(5);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      registrationEnabled: false,
    } as never);

    const res = await GET(validRequest());

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "error=oidc_registration_disabled",
    );
  });

  it("never stamps the session step-up fresh — the 5th createSession arg is null", async () => {
    mockIdentity();
    mockUserLookups({
      byIdentity: userRow({ oidcIssuer: METADATA.issuer, oidcSub: "sub-1" }),
    });

    await GET(validRequest());

    expect(createSession).toHaveBeenCalledWith(
      "user-1",
      false,
      "1.2.3.4",
      null,
      null,
    );
  });

  it("routes a TOTP-enrolled account through the MFA challenge instead of logging in", async () => {
    mockIdentity();
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
        totpConfirmedAt: new Date(),
      }),
    });

    const res = await GET(validRequest("/dashboard"));

    // No session — the partial state lives in the single-use ticket.
    expect(createSession).not.toHaveBeenCalled();
    expect(createMfaChallenge).toHaveBeenCalledWith("user-1", "login");

    const location = res.headers.get("location")!;
    expect(location).toContain("/auth/login");
    expect(location).not.toContain("error=");
    // `next` continuation rides the query string into the login page.
    expect(location).toContain(`next=${encodeURIComponent("/dashboard")}`);

    // The ticket + methods ride the login-page-scoped handoff cookie.
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("oidc_mfa_handoff=");
    expect(setCookie).toContain(encodeURIComponent("mfa-ticket-1"));
    expect(setCookie.toLowerCase()).toContain("path=/auth/login");
    expect(decodeURIComponent(setCookie)).toContain('"totp"');
  });

  it("offers only the security-key method for a WebAuthn-only account", async () => {
    mockIdentity();
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
        totpConfirmedAt: null,
      }),
    });
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(1);

    const res = await GET(validRequest());

    expect(createSession).not.toHaveBeenCalled();
    const setCookie = decodeURIComponent(res.headers.getSetCookie().join("\n"));
    expect(setCookie).toContain('"webauthn"');
    expect(setCookie).not.toContain('"totp"');
  });

  it("redirects with oidc_failed when the token exchange throws", async () => {
    vi.mocked(exchangeCodeForTokens).mockRejectedValue(new Error("network"));
    const res = await GET(validRequest());
    expect(res.headers.get("location")).toContain("error=oidc_failed");
  });

  it("deletes the state cookie with the exact path it was set under", async () => {
    // RFC 6265 keys cookies by (name, domain, path) — a deletion without
    // `Path=/api/auth/oidc` would target a `/`-scoped cookie that does not
    // exist and leave the real single-use blob alive.
    const errorRes = await GET(makeRequest({ query: "?error=access_denied" }));
    const errorCookie = errorRes.headers
      .getSetCookie()
      .find((c) => c.startsWith("oidc_auth_state="))!;
    expect(errorCookie.toLowerCase()).toContain("path=/api/auth/oidc");

    mockIdentity();
    mockUserLookups({
      byIdentity: userRow({ oidcIssuer: METADATA.issuer, oidcSub: "sub-1" }),
    });
    const successRes = await GET(validRequest());
    const successCookie = successRes.headers
      .getSetCookie()
      .find((c) => c.startsWith("oidc_auth_state="))!;
    expect(successCookie.toLowerCase()).toContain("path=/api/auth/oidc");
  });
});

describe("GET /api/auth/oidc/callback — duplicate-callback idempotency", () => {
  // A duplicated callback for the SAME sign-in: the first callback already
  // redeemed the single-use code, set the session cookie, and deleted the
  // single-use state cookie — so the duplicate arrives with a live `code` +
  // `state` in the query but NO state cookie. Whether it also fails closed
  // turns entirely on whether a VALIDATED session is present.
  function duplicateRequest(withSession: boolean): NextRequest {
    const req = new NextRequest(
      "http://localhost/api/auth/oidc/callback?code=abc&state=STATE",
    );
    if (withSession)
      req.cookies.set("healthlog_session", fixtureSessionSecret());
    return req;
  }

  it("redirects a duplicate into the app when a valid session is present, WITHOUT re-redeeming the code", async () => {
    vi.mocked(validateSessionFromCookieValue).mockResolvedValue({
      session: { id: "sess-1", expiresAt: new Date(Date.now() + 1_000_000) },
      user: userRow() as never,
    } as never);

    const res = await GET(duplicateRequest(true));

    const location = res.headers.get("location")!;
    // Lands in the app, not on the error page.
    expect(location).not.toContain("error=");
    expect(new URL(location).pathname).toBe("/");
    // The now-consumed authorization code is NEVER exchanged again, and no
    // second session is minted — the redirect is inert.
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("still fails closed (oidc_state) for a consumed/forged state with NO valid session", async () => {
    // The security assertion: a caller who presents a real-looking callback
    // but holds no valid session gets the unchanged error and the code is
    // never redeemed. This must stay red if the fail-closed path is weakened.
    vi.mocked(validateSessionFromCookieValue).mockResolvedValue(null);

    const res = await GET(duplicateRequest(false));

    expect(res.headers.get("location")).toContain("error=oidc_state");
    expect(exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/oidc/callback — native branch", () => {
  beforeEach(() => {
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: true,
      remaining: 20,
      reset: 0,
      ip: "1.2.3.4",
    } as never);
    vi.mocked(getOidcConfig).mockReturnValue(CONFIG);
    vi.mocked(discoverOidcMetadata).mockResolvedValue(METADATA);
    vi.mocked(prisma.webauthnMfaCredential.count).mockResolvedValue(0);
    vi.mocked(mintNativeHandoff).mockResolvedValue({
      code: "hlh_test_code",
      handoffId: "ho-1",
    });
  });

  function nativeStateCookie(overrides: Record<string, unknown> = {}): string {
    return stateCookie({
      state: "STATE",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      next: "/",
      native: true,
      appCodeChallenge: "app-challenge-123",
      ...overrides,
    });
  }

  function nativeRequest(): NextRequest {
    return makeRequest({
      query: "?code=abc&state=STATE",
      cookie: nativeStateCookie(),
    });
  }

  it("mints a handoff code and 302s to the custom scheme — no session", async () => {
    mockIdentity();
    mockUserLookups({
      byIdentity: userRow({ oidcIssuer: METADATA.issuer, oidcSub: "sub-1" }),
    });

    const res = await GET(nativeRequest());
    const location = res.headers.get("location")!;
    expect(location.startsWith("healthlog://oidc-callback?code=")).toBe(true);
    expect(location).toContain("code=hlh_test_code");
    // The app's challenge (from the tamper-authenticated blob) is bound at mint.
    expect(mintNativeHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        appCodeChallenge: "app-challenge-123",
      }),
    );
    // No web session is minted on the native branch.
    expect(createSession).not.toHaveBeenCalled();
  });

  it("hands the MFA ticket to the custom scheme (no session, no MFA cookie)", async () => {
    mockIdentity();
    mockUserLookups({
      byIdentity: userRow({
        oidcIssuer: METADATA.issuer,
        oidcSub: "sub-1",
        totpConfirmedAt: new Date(),
      }),
    });

    const res = await GET(nativeRequest());
    const location = res.headers.get("location")!;
    expect(location.startsWith("healthlog://oidc-callback?")).toBe(true);
    expect(location).toContain("mfa_ticket=mfa-ticket-1");
    expect(location).toContain("methods=totp%2Crecovery");
    // No handoff code on the MFA branch, and no session.
    expect(location).not.toContain("code=hlh_");
    expect(mintNativeHandoff).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    // The web-only MFA handoff cookie is never set on the native branch.
    const mfaCookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("oidc_mfa_handoff="));
    expect(mfaCookie).toBeUndefined();
  });

  it("delivers a post-identity error to the custom scheme, not a web page", async () => {
    mockIdentity();
    // An account already pinned to a different IdP identity → identity_conflict.
    mockUserLookups({
      byIdentity: null,
      byEmail: userRow({ oidcIssuer: "https://other.example", oidcSub: "x" }),
    });

    const res = await GET(nativeRequest());
    const location = res.headers.get("location")!;
    expect(location).toBe(
      "healthlog://oidc-callback?error=oidc_identity_conflict",
    );
  });

  it("delivers an IdP denial to the custom scheme", async () => {
    const res = await GET(
      makeRequest({
        query: "?error=access_denied&state=STATE",
        cookie: nativeStateCookie(),
      }),
    );
    expect(res.headers.get("location")).toBe(
      "healthlog://oidc-callback?error=oidc_denied",
    );
  });

  it("falls back to the WEB oidc_state page on a CSRF mismatch (broken flow)", async () => {
    const res = await GET(
      makeRequest({
        query: "?code=abc&state=WRONG",
        cookie: nativeStateCookie(),
      }),
    );
    // A tampered/broken round-trip never hands the app a scheme redirect.
    expect(res.headers.get("location")).toContain(
      "/auth/login?error=oidc_state",
    );
  });
});
