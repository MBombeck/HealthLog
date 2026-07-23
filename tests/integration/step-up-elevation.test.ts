/**
 * Behavioural suite for token-bound step-up elevations, against a real Postgres
 * and the real gate — no mocked Prisma, no mocked auth.
 *
 * This mechanism lets a Bearer token reach a surface that has been cookie-only
 * since v1.23, so the cases below are written as attacks rather than as happy
 * paths. Each one must fail closed if its protection is removed; a green suite
 * over a broken gate would be worse than no suite at all.
 *
 * Two of them need a real database to mean anything. Single-use atomicity is a
 * claim about what Postgres does when two writers race the same row, and the
 * unit mocks cannot produce that race — E3b runs the two redemptions genuinely
 * concurrently against one connection pool. The token binding is a claim about a
 * WHERE clause, and only a real query proves the clause is in it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-step-up-elevation-32-bytes-minimum-1234567890";

const { hashToken } = await import("@/lib/auth/hmac");
const { hashPassword } = await import("@/lib/auth/password");

const USER_ID = "user-step-up-test";
const OTHER_USER_ID = "user-step-up-other";
const PASSWORD = "correct horse battery staple 42";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  const passwordHash = await hashPassword(PASSWORD);
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "step-up",
      email: "step-up@example.test",
      timezone: "UTC",
      passwordHash,
    },
  });
  await getPrismaClient().user.create({
    data: {
      id: OTHER_USER_ID,
      username: "step-up-other",
      email: "step-up-other@example.test",
      timezone: "UTC",
      passwordHash,
    },
  });
});

/** Mint a real wildcard `ApiToken` row. Does NOT arm the header. */
async function mintToken(
  label: string,
  userId = USER_ID,
): Promise<{ raw: string; id: string }> {
  const raw = `hlk_${label}${"0".repeat(64 - label.length)}`;
  const row = await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: label,
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
    select: { id: true },
  });
  return { raw, id: row.id };
}

function useToken(raw: string): void {
  headerJar.set("authorization", `Bearer ${raw}`);
}

function useElevation(raw: string | null): void {
  if (raw === null) headerJar.delete("x-step-up");
  else headerJar.set("x-step-up", raw);
}

function req(path: string, method = "GET", body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  const auth = headerJar.get("authorization");
  if (auth) headers.authorization = auth;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`https://health.example${path}`, init as never);
}

/** Drive the mint endpoint with an arbitrary proof body. */
async function mintWith(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/auth/step-up/route");
  const res = await POST(req("/api/auth/step-up", "POST", body));
  return { status: res.status, body: (await res.json()) as never };
}

/** Drive the mint endpoint with a password proof. */
async function mintElevation(
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return mintWith({ method: "password", password });
}

/**
 * Mint a TOTP-proved elevation the way a real client would: enrol a secret,
 * then present a live code for it. This is the only fresh-factor arm reachable
 * without a WebAuthn authenticator, so it carries the fresh-factor coverage.
 */
async function enrolTotp(): Promise<string> {
  const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
  const { encrypt } = await import("@/lib/crypto");
  const secret = generateTotpSecret();
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: {
      totpSecretEncrypted: encrypt(secret),
      totpConfirmedAt: new Date(),
      totpLastStep: null,
    },
  });
  return secret;
}

/** Mirrors the server's TOTP parameters — there is no code generator to import. */
function currentTotpCode(secretBase32: string): string {
  const totp = new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  return totp.generate({ timestamp: Date.now() });
}

async function mintTotpElevation(
  secret: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return mintWith({ method: "totp", code: currentTotpCode(secret) });
}

/**
 * Seed a known recovery-code batch and return the plaintext.
 *
 * The disable route wants a live factor in its BODY on top of the step-up. A
 * TOTP code spent minting the elevation cannot be reused there — the shared
 * verifier burns its time-step, by design — so within one 30-second window the
 * body factor has to be something else. That is exactly how the web behaves
 * too.
 */
async function seedRecoveryCodes(): Promise<string[]> {
  const { regenerateRecoveryCodes } =
    await import("@/lib/auth/mfa/recovery-codes");
  return regenerateRecoveryCodes(USER_ID);
}

/** Pull the raw elevation out of a successful mint. */
function elevationOf(result: { body: Record<string, unknown> }): string {
  return (result.body.data as { elevation: string }).elevation;
}

/**
 * Some handlers in the set declare no request parameter (`apiHandler(async () =>
 * …)`), so their wrapped type takes none. The runtime always passes one; this
 * keeps the call sites honest without loosening the handlers themselves.
 */
type RouteFn = (request: NextRequest) => Promise<Response>;

/**
 * POST /api/auth/me/mfa/totp/setup — the cheapest MUTATION in the
 * elevation-accepting set, and the probe every redemption case drives.
 *
 * NOT `GET /api/auth/me/mfa`: that read is plain `requireAuth()` now, so using
 * it here would have quietly stopped exercising the elevation path at all.
 */
async function callMfaSetup(): Promise<Response> {
  const { POST } = await import("@/app/api/auth/me/mfa/totp/setup/route");
  return await POST(req("/api/auth/me/mfa/totp/setup", "POST"));
}

/** The status read — plain Bearer, no elevation. */
async function callMfaStatus(): Promise<Response> {
  const { GET } = await import("@/app/api/auth/me/mfa/route");
  return await (GET as unknown as RouteFn)(req("/api/auth/me/mfa"));
}

async function auditReasons(action: string): Promise<string[]> {
  const rows = await getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(
    (r) => (JSON.parse(r.details ?? "{}") as { reason?: string }).reason ?? "",
  );
}

// ── E1 — a stolen token, on its own, gains nothing ───────────────────

describe("E1 — the token alone is not a step-up proof", () => {
  it("refuses an MFA-management call with no elevation header", async () => {
    const { raw } = await mintToken("e1a");
    useToken(raw);
    useElevation(null);

    const res = await callMfaSetup();

    // 401 with the machine code the client branches on to launch a re-proof —
    // not a 200, and not the 403 an unauthorised token would get.
    expect(res.status).toBe(401);
  });

  it("mints nothing when the body carries no factor proof", async () => {
    const { raw } = await mintToken("e1b");
    useToken(raw);

    const { POST } = await import("@/app/api/auth/step-up/route");
    const res = await POST(req("/api/auth/step-up", "POST", {}));

    expect(res.status).toBe(422);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("refuses a fabricated elevation value", async () => {
    const { raw } = await mintToken("e1c");
    useToken(raw);
    useElevation(`hle_${"f".repeat(64)}`);

    expect((await callMfaSetup()).status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "unknown",
    );
  });
});

// ── E2 — the elevation is bound to one token ─────────────────────────

describe("E2 — an elevation is not portable between tokens", () => {
  it("refuses redemption by a second token of the SAME user", async () => {
    const a = await mintToken("e2a");
    const b = await mintToken("e2b");

    useToken(a.raw);
    const minted = await mintElevation(PASSWORD);
    expect(minted.status).toBe(200);
    const elevation = (minted.body.data as { elevation: string }).elevation;

    // Same account, same scopes, different token row. The binding is the only
    // thing standing between these two, which is exactly the point.
    useToken(b.raw);
    useElevation(elevation);
    const res = await callMfaSetup();

    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "wrong_token",
    );

    // And the legitimate holder's elevation survived the attempt.
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();

    useToken(a.raw);
    useElevation(elevation);
    expect((await callMfaSetup()).status).toBe(200);
  });

  it("refuses redemption by another user's token", async () => {
    const mine = await mintToken("e2c");
    const theirs = await mintToken("e2d", OTHER_USER_ID);

    useToken(mine.raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    useToken(theirs.raw);
    useElevation(elevation);

    expect((await callMfaSetup()).status).toBe(401);
  });
});

// ── E3 — single use, including under concurrency ─────────────────────

describe("E3 — an elevation is consumed exactly once", () => {
  it("refuses a second sequential redemption", async () => {
    const { raw } = await mintToken("e3a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    useElevation(elevation);
    expect((await callMfaSetup()).status).toBe(200);
    expect((await callMfaSetup()).status).toBe(401);

    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "consumed",
    );
  });

  it("lets exactly one of two CONCURRENT redemptions win", async () => {
    const { raw, id } = await mintToken("e3b");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    // Straight at the redemption primitive, so the race is between two real
    // conditional UPDATEs on one row rather than between two HTTP handlers that
    // happen to interleave. A check-then-update implementation passes the
    // sequential case above and fails here.
    const { claimStepUpElevation } = await import("@/lib/auth/step-up");
    const attempt = () =>
      claimStepUpElevation({
        rawToken: elevation,
        userId: USER_ID,
        apiTokenId: id,
        requireFreshFactor: false,
      });

    const results: Awaited<ReturnType<typeof attempt>>[] = await Promise.all([
      attempt(),
      attempt(),
      attempt(),
      attempt(),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
  });
});

// ── E4 — expiry ──────────────────────────────────────────────────────

describe("E4 — an expired elevation is refused", () => {
  it("refuses one whose window has passed", async () => {
    const { raw, id } = await mintToken("e4a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    // Age the row rather than the clock: the expiry lives in the redemption's
    // WHERE clause, so this is the honest way to exercise it.
    await getPrismaClient().stepUpElevation.updateMany({
      where: { apiTokenId: id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    useElevation(elevation);
    expect((await callMfaSetup()).status).toBe(401);

    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "expired",
    );
  });

  it("mints a five-minute window, matching the cookie step-up", async () => {
    const { raw } = await mintToken("e4b");
    useToken(raw);
    const { body } = await mintElevation(PASSWORD);
    const data = body.data as { expiresInSeconds: number };

    const { MFA_STEP_UP_MAX_AGE_SECONDS } = await import("@/lib/api-handler");
    expect(data.expiresInSeconds).toBe(MFA_STEP_UP_MAX_AGE_SECONDS);
  });
});

// ── E5 — the elevation cannot reach admin ────────────────────────────

describe("E5 — an elevation does not satisfy requireAdmin", () => {
  it("refuses an admin route even for an ADMIN user holding a valid elevation", async () => {
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { role: "ADMIN" },
    });

    const { raw } = await mintToken("e5a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;
    useElevation(elevation);

    const { GET } = await import("@/app/api/admin/users/route");
    const res = await (GET as unknown as RouteFn)(req("/api/admin/users"));

    // Cookie-only, and the elevation is not a cookie. The account being a
    // genuine admin is what makes this test worth having: the refusal is the
    // transport, not the role.
    expect(res.status).toBe(401);

    // Unconsumed — the admin gate never even looked at it.
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });
});

// ── E6 — a wrong password mints nothing, is throttled, is audited ────

describe("E6 — the mint refuses, throttles, and records a bad password", () => {
  it("returns a generic 401 and writes no row", async () => {
    const { raw } = await mintToken("e6a");
    useToken(raw);

    const res = await mintElevation("not the password");

    expect(res.status).toBe(401);
    // Same prose for every cause — the response must not say whether the
    // password was wrong or the account has none.
    expect(res.body.error).toBe("Verification failed");
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("is indistinguishable from an account with no password set", async () => {
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { passwordHash: null },
    });
    const { raw } = await mintToken("e6b");
    useToken(raw);

    const res = await mintElevation("anything at all");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Verification failed");
  });

  it("audits the failure with the real reason", async () => {
    const { raw } = await mintToken("e6c");
    useToken(raw);
    await mintElevation("wrong");

    const rows = await getPrismaClient().auditLog.findMany({
      where: { action: "auth.stepup.mint.failed" },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toMatchObject({
      method: "password",
      reason: "bad_password",
    });
  });

  it("throttles a guessing run", async () => {
    const { raw } = await mintToken("e6d");
    useToken(raw);

    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await mintElevation(`guess-${i}`)).status);
    }

    // Five attempts per fifteen minutes, then the bucket closes — the same
    // ceiling the password-change route uses, for the same Argon2id reason.
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);

    // And the throttle holds even once the caller finds the right password.
    expect((await mintElevation(PASSWORD)).status).toBe(429);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});

// ── E7 — the web path is untouched ───────────────────────────────────

describe("E7 — the cookie flow is unchanged", () => {
  async function useCookieSession(userId = USER_ID): Promise<string> {
    const session = await getPrismaClient().session.create({
      data: { userId, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    return session.id;
  }

  it("serves an MFA-management mutation on a plain cookie session", async () => {
    await useCookieSession();
    expect((await callMfaSetup()).status).toBe(200);
  });

  it("still refuses a step-up-gated route on a cookie with no fresh factor", async () => {
    await useCookieSession();
    const { POST } =
      await import("@/app/api/auth/me/mfa/recovery-codes/regenerate/route");
    const res = await POST(
      req("/api/auth/me/mfa/recovery-codes/regenerate", "POST"),
    );
    expect(res.status).toBe(401);
  });

  it("admits a step-up-gated route on a freshly verified cookie session", async () => {
    const sessionId = await useCookieSession();
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { totpConfirmedAt: new Date() },
    });
    await getPrismaClient().session.update({
      where: { id: sessionId },
      data: { mfaVerifiedAt: new Date() },
    });

    const { POST } =
      await import("@/app/api/auth/me/mfa/recovery-codes/regenerate/route");
    const res = await POST(
      req("/api/auth/me/mfa/recovery-codes/regenerate", "POST"),
    );
    expect(res.status).toBe(200);
  });

  it("ignores an elevation header when a cookie session is present", async () => {
    // The cookie branch returns before the header is ever read. Proven by the
    // elevation surviving unconsumed.
    const { raw, id } = await mintToken("e7a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    await useCookieSession();
    useElevation(elevation);
    expect((await callMfaSetup()).status).toBe(200);

    const row = await getPrismaClient().stepUpElevation.findFirst({
      where: { apiTokenId: id },
    });
    expect(row?.consumedAt).toBeNull();
  });
});

// ── E8 — invalidation on credential rotation ─────────────────────────

describe("E8 — an elevation does not outlive its anchor", () => {
  it("is dropped by a real password change, through the route", async () => {
    // Driven through POST /api/auth/password rather than by calling the
    // revocation helper. Calling the helper directly proved only that the helper
    // deletes rows — deleting the call from BOTH password routes left the old
    // version of this test green, so the invalidation story was uncovered.
    const { raw } = await mintToken("e8a");
    useToken(raw);
    const elevation = elevationOf(await mintElevation(PASSWORD));
    expect(await getPrismaClient().stepUpElevation.count()).toBe(1);

    const NEW_PASSWORD = "Zt7#qvbLm2xR!e9Wd4Kp";
    const { POST } = await import("@/app/api/auth/password/route");
    const res = await POST(
      req("/api/auth/password", "POST", {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      }),
    );
    expect(res.status).toBe(200);

    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);

    // And the value the client still holds is dead. The password route mints a
    // replacement cookie session, which the shared jar would otherwise pick up
    // and satisfy the gate on the cookie arm — clear it so this probes the
    // Bearer arm, which is the one under test.
    cookieJar.clear();
    useElevation(elevation);
    expect((await callMfaSetup()).status).toBe(401);
  });

  it("is dropped by an operator-forced reset, through the admin route", async () => {
    const { raw } = await mintToken("e8a2");
    useToken(raw);
    await mintElevation(PASSWORD);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(1);

    // The admin route is cookie-only, so the reset arrives on an ADMIN session
    // while the elevation belongs to the target's token.
    await getPrismaClient().user.update({
      where: { id: OTHER_USER_ID },
      data: { role: "ADMIN" },
    });
    const adminSession = await getPrismaClient().session.create({
      data: {
        userId: OTHER_USER_ID,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    cookieJar.set("healthlog_session", adminSession.id);
    headerJar.delete("authorization");

    const { POST } =
      await import("@/app/api/admin/users/[id]/reset-password/route");
    const res = await POST(
      req(`/api/admin/users/${USER_ID}/reset-password`, "POST", {
        password: "operator chosen long passphrase 77",
      }),
      { params: Promise.resolve({ id: USER_ID }) },
    );
    expect(res.status).toBe(200);

    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("is dropped by sign-out-everywhere", async () => {
    const { raw } = await mintToken("e8a3");
    useToken(raw);
    await mintElevation(PASSWORD);

    const session = await getPrismaClient().session.create({
      data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const { destroyOtherSessions } = await import("@/lib/auth/session");
    await destroyOtherSessions(USER_ID, {
      kind: "session",
      sessionId: session.id,
    });

    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });

  it("is unredeemable once the bound token is revoked", async () => {
    const { raw, id } = await mintToken("e8b");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    await getPrismaClient().apiToken.update({
      where: { id },
      data: { revoked: true },
    });

    useElevation(elevation);
    // Refused at Bearer resolution, before the elevation is even looked at —
    // which is why no code in the revoke path needs to know about elevations.
    expect((await callMfaSetup()).status).toBe(401);

    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });

  it("is cascade-deleted with the token row", async () => {
    const { raw, id } = await mintToken("e8c");
    useToken(raw);
    await mintElevation(PASSWORD);

    await getPrismaClient().apiToken.delete({ where: { id } });

    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});

// ── E9 — the happy path actually works end to end ────────────────────

describe("E9 — a native client can manage its second factor", () => {
  it("mints, redeems, and enrols TOTP", async () => {
    const { raw } = await mintToken("e9a");
    useToken(raw);
    const elevation = (
      (await mintElevation(PASSWORD)).body.data as { elevation: string }
    ).elevation;

    useElevation(elevation);
    const { POST } = await import("@/app/api/auth/me/mfa/totp/setup/route");
    const res = await POST(req("/api/auth/me/mfa/totp/setup", "POST"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { totpSecret: string; otpauthUri: string };
    };
    expect(body.data.totpSecret).toBeTruthy();
    expect(body.data.otpauthUri).toMatch(/^otpauth:\/\//);

    // The pending secret landed, and the elevation is spent — a second action
    // needs a second proof.
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
    });
    expect(user?.totpSecretEncrypted).toBeTruthy();
    expect(user?.totpConfirmedAt).toBeNull();
    expect((await callMfaSetup()).status).toBe(401);
  });

  it("refuses the mint surface to a cookie session", async () => {
    const session = await getPrismaClient().session.create({
      data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
    headerJar.delete("authorization");

    const { POST } = await import("@/app/api/auth/step-up/route");
    const res = await POST(
      req("/api/auth/step-up", "POST", {
        method: "password",
        password: PASSWORD,
      }),
    );

    expect(res.status).toBe(401);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});

// ── E10 — the fresh-factor rule (B1) ─────────────────────────────────

describe("E10 — a password proof cannot reach the destructive routes", () => {
  /**
   * The attack this closes, in the order it ran before the fix:
   *   1. mint an elevation with the account password (a stolen token plus a
   *      known password is the whole prerequisite);
   *   2. POST recovery-codes/regenerate — which takes NO factor in its body —
   *      and receive ten plaintext recovery codes;
   *   3. POST disable with one of them, satisfying the body check.
   * The second factor is gone. On the web that chain is impossible because a
   * password login never stamps `mfaVerifiedAt`.
   */
  async function regenerate(): Promise<Response> {
    const { POST } =
      await import("@/app/api/auth/me/mfa/recovery-codes/regenerate/route");
    return POST(req("/api/auth/me/mfa/recovery-codes/regenerate", "POST"));
  }

  async function disable(code: string, method = "recovery"): Promise<Response> {
    const { POST } = await import("@/app/api/auth/me/mfa/disable/route");
    return POST(req("/api/auth/me/mfa/disable", "POST", { code, method }));
  }

  async function removeKey(id: string): Promise<Response> {
    const { DELETE } =
      await import("@/app/api/auth/me/mfa/webauthn/[id]/route");
    return DELETE(req(`/api/auth/me/mfa/webauthn/${id}`, "DELETE"), {
      params: Promise.resolve({ id }),
    });
  }

  it("refuses recovery-code regeneration on a password-proved elevation", async () => {
    await enrolTotp();
    const { raw } = await mintToken("e10a");
    useToken(raw);
    useElevation(elevationOf(await mintElevation(PASSWORD)));

    const res = await regenerate();

    expect(res.status).toBe(401);
    // No codes were minted, so step 2 of the chain yields nothing.
    expect(await getPrismaClient().mfaRecoveryCode.count()).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(await auditReasons("auth.stepup.elevation.rejected")).toContain(
      "insufficient_factor",
    );
  });

  it("refuses disable on a password-proved elevation", async () => {
    const secret = await enrolTotp();
    const { raw } = await mintToken("e10b");
    useToken(raw);
    useElevation(elevationOf(await mintElevation(PASSWORD)));

    const res = await disable(currentTotpCode(secret), "totp");

    expect(res.status).toBe(401);
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
    });
    expect(user?.totpConfirmedAt).not.toBeNull();
  });

  it("refuses security-key removal on a password-proved elevation", async () => {
    const key = await getPrismaClient().webauthnMfaCredential.create({
      data: {
        userId: USER_ID,
        name: "key",
        credentialId: "cred-e10c",
        credentialPublicKey: Buffer.from([1, 2, 3]),
        transports: ["internal"],
      },
    });
    const { raw } = await mintToken("e10c");
    useToken(raw);
    useElevation(elevationOf(await mintElevation(PASSWORD)));

    expect((await removeKey(key.id)).status).toBe(401);
    expect(await getPrismaClient().webauthnMfaCredential.count()).toBe(1);
  });

  it("refuses at the CLAIM too, not only at the validation", async () => {
    // Defence in depth, and it needs its own test: the gate validates before it
    // claims, so removing the check inside `claimStepUpElevation` leaves every
    // route-level case above green. Driven straight at the primitive.
    const { raw, id } = await mintToken("e10i");
    useToken(raw);
    const elevation = elevationOf(await mintElevation(PASSWORD));

    const { claimStepUpElevation } = await import("@/lib/auth/step-up");
    const claimed = await claimStepUpElevation({
      rawToken: elevation,
      userId: USER_ID,
      apiTokenId: id,
      requireFreshFactor: true,
    });

    expect(claimed).toEqual({ ok: false, reason: "insufficient_factor" });
  });

  it("does NOT burn the elevation when the factor is too weak", async () => {
    // The refusal is about reach, not validity. The same elevation must still
    // work on the routes it was always entitled to.
    await enrolTotp();
    const { raw } = await mintToken("e10d");
    useToken(raw);
    const elevation = elevationOf(await mintElevation(PASSWORD));

    useElevation(elevation);
    expect((await regenerate()).status).toBe(401);

    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });

  it("admits the SAME routes a plain cookie session reaches", async () => {
    // The password arm is not useless — it is exactly cookie-equivalent.
    const { raw } = await mintToken("e10e");
    useToken(raw);
    useElevation(elevationOf(await mintElevation(PASSWORD)));

    expect((await callMfaSetup()).status).toBe(200);
  });

  it("admits the destructive routes on a TOTP-proved elevation", async () => {
    const secret = await enrolTotp();
    const { raw } = await mintToken("e10f");
    useToken(raw);

    const minted = await mintTotpElevation(secret);
    expect(minted.status).toBe(200);
    expect(
      (minted.body.data as { satisfiesFreshFactor: boolean })
        .satisfiesFreshFactor,
    ).toBe(true);

    useElevation(elevationOf(minted));
    const res = await regenerate();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { recoveryCodes: string[] };
    };
    expect(body.data.recoveryCodes.length).toBeGreaterThan(0);
  });

  it("marks a password-proved elevation as not fresh-factor in the mint response", async () => {
    const { raw } = await mintToken("e10g");
    useToken(raw);
    const minted = await mintElevation(PASSWORD);
    const data = minted.body.data as {
      method: string;
      satisfiesFreshFactor: boolean;
    };
    expect(data.method).toBe("password");
    expect(data.satisfiesFreshFactor).toBe(false);
  });

  it("refuses a stale TOTP code and does not mint", async () => {
    const secret = await enrolTotp();
    const { raw } = await mintToken("e10h");
    useToken(raw);

    // Spend the code through the shared verifier first; the replay guard must
    // then refuse the same code here, exactly as it does at login.
    const code = currentTotpCode(secret);
    const { verifyMfaFactor } = await import("@/lib/auth/mfa/verify-factor");
    const user = await getPrismaClient().user.findUnique({
      where: { id: USER_ID },
    });
    await verifyMfaFactor(user!, "totp", code);

    const res = await mintWith({ method: "totp", code });

    expect(res.status).toBe(401);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});

// ── E11 — the disable route keeps the caller signed in (B2) ──────────

describe("E11 — disabling MFA over Bearer spares the calling device", () => {
  it("revokes every OTHER refresh token but not the caller's own", async () => {
    const secret = await enrolTotp();
    const { raw, id } = await mintToken("e11a");

    const { hashToken } = await import("@/lib/auth/hmac");
    // The caller's own device login: the RefreshToken row cross-referencing the
    // access token being presented.
    const mine = await getPrismaClient().refreshToken.create({
      data: {
        userId: USER_ID,
        tokenHash: hashToken(`hlr_mine${"0".repeat(56)}`),
        accessTokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
      },
    });
    // Another device.
    const theirs = await getPrismaClient().refreshToken.create({
      data: {
        userId: USER_ID,
        tokenHash: hashToken(`hlr_theirs${"0".repeat(54)}`),
        accessTokenHash: hashToken(`hlk_other${"0".repeat(55)}`),
        expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
      },
    });
    // And a browser session, which has no "current" on the Bearer path.
    const webSession = await getPrismaClient().session.create({
      data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const codes = await seedRecoveryCodes();
    useToken(raw);
    useElevation(elevationOf(await mintTotpElevation(secret)));

    const { POST } = await import("@/app/api/auth/me/mfa/disable/route");
    const res = await POST(
      req("/api/auth/me/mfa/disable", "POST", {
        code: codes[0],
        method: "recovery",
      }),
    );
    expect(res.status).toBe(200);

    // The defect: passing the ApiToken id where a Session id was expected made
    // the "keep the current one" exclusion match nothing, so the caller's own
    // refresh token was revoked and the app logged itself out at next rotation.
    const mineAfter = await getPrismaClient().refreshToken.findUnique({
      where: { id: mine.id },
    });
    const theirsAfter = await getPrismaClient().refreshToken.findUnique({
      where: { id: theirs.id },
    });
    expect(mineAfter?.revokedAt).toBeNull();
    expect(theirsAfter?.revokedAt).not.toBeNull();

    // Web sessions all go — none of them is the caller.
    expect(
      await getPrismaClient().session.findUnique({
        where: { id: webSession.id },
      }),
    ).toBeNull();

    // And the calling token itself is untouched, so the next request works.
    const token = await getPrismaClient().apiToken.findUnique({
      where: { id },
    });
    expect(token?.revoked).toBe(false);
  });

  it("keeps the caller's own session on the cookie path, as before", async () => {
    const secret = await enrolTotp();
    const current = await getPrismaClient().session.create({
      data: {
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 3_600_000),
        mfaVerifiedAt: new Date(),
      },
    });
    const other = await getPrismaClient().session.create({
      data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", current.id);
    headerJar.delete("authorization");

    const { POST } = await import("@/app/api/auth/me/mfa/disable/route");
    const res = await POST(
      req("/api/auth/me/mfa/disable", "POST", {
        code: currentTotpCode(secret),
        method: "totp",
      }),
    );
    expect(res.status).toBe(200);

    expect(
      await getPrismaClient().session.findUnique({ where: { id: current.id } }),
    ).not.toBeNull();
    expect(
      await getPrismaClient().session.findUnique({ where: { id: other.id } }),
    ).toBeNull();
  });
});

// ── E12 — validation failures do not burn the proof ──────────────────

describe("E12 — a rejected request keeps the elevation spendable", () => {
  it("survives a wrong TOTP code on disable", async () => {
    const secret = await enrolTotp();
    const codes = await seedRecoveryCodes();
    const { raw } = await mintToken("e12a");
    useToken(raw);
    const elevation = elevationOf(await mintTotpElevation(secret));

    useElevation(elevation);
    const { POST } = await import("@/app/api/auth/me/mfa/disable/route");
    const bad = await POST(
      req("/api/auth/me/mfa/disable", "POST", {
        code: "000000",
        method: "totp",
      }),
    );
    expect(bad.status).toBe(401);

    // Unspent — otherwise five fat-fingered codes would exhaust the 5-per-15-min
    // mint ceiling and lock the user out of their own security settings.
    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();

    // And the retry goes through on the SAME elevation.
    const good = await POST(
      req("/api/auth/me/mfa/disable", "POST", {
        code: codes[0],
        method: "recovery",
      }),
    );
    expect(good.status).toBe(200);
  });

  it("IS spent once the route actually acts", async () => {
    // The other half of the two-phase split. Deferring the claim buys nothing if
    // the route then forgets to make it — the elevation would stay redeemable
    // for the rest of its five minutes.
    //
    // Driven through recovery-code regeneration rather than disable: disable
    // calls `destroyOtherSessions`, which deletes the account's elevations
    // outright, so the row is gone afterwards either way and the assertion
    // would pass whether or not the route committed. Regeneration leaves the
    // row in place, so `consumedAt` is a real observation.
    const secret = await enrolTotp();
    const { raw } = await mintToken("e12c");
    useToken(raw);
    const elevation = elevationOf(await mintTotpElevation(secret));

    useElevation(elevation);
    const { POST } =
      await import("@/app/api/auth/me/mfa/recovery-codes/regenerate/route");
    const ok = await POST(
      req("/api/auth/me/mfa/recovery-codes/regenerate", "POST"),
    );
    expect(ok.status).toBe(200);

    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row).not.toBeNull();
    expect(row?.consumedAt).not.toBeNull();

    // And the spent value opens nothing else.
    expect((await callMfaSetup()).status).toBe(401);
  });

  it("survives a malformed body", async () => {
    const { raw } = await mintToken("e12b");
    useToken(raw);
    useElevation(elevationOf(await mintElevation(PASSWORD)));

    const { POST } =
      await import("@/app/api/auth/me/mfa/webauthn/register/verify/route");
    const res = await POST(
      req("/api/auth/me/mfa/webauthn/register/verify", "POST", { nope: 1 }),
    );
    expect(res.status).toBe(422);

    const row = await getPrismaClient().stepUpElevation.findFirst();
    expect(row?.consumedAt).toBeNull();
  });
});

// ── E13 — the status read is plain Bearer ────────────────────────────

describe("E13 — the second-factor status read needs no elevation", () => {
  it("serves a token with no elevation header at all", async () => {
    const { raw } = await mintToken("e13a");
    useToken(raw);
    useElevation(null);

    const res = await callMfaStatus();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { totp: { enabled: boolean }; webauthn: unknown[] };
    };
    expect(body.data.totp).toBeDefined();
    expect(Array.isArray(body.data.webauthn)).toBe(true);
  });

  it("carries no credential material", async () => {
    await getPrismaClient().webauthnMfaCredential.create({
      data: {
        userId: USER_ID,
        name: "key",
        credentialId: "cred-e13b-secret",
        credentialPublicKey: Buffer.from([9, 9, 9]),
        transports: ["internal"],
      },
    });
    const { raw } = await mintToken("e13b");
    useToken(raw);

    const text = await (await callMfaStatus()).text();

    // The justification for relaxing this route is that the payload is inert.
    // Pin it: no credential id, no public key, no codes.
    expect(text).not.toContain("cred-e13b-secret");
    expect(text).not.toContain("credentialPublicKey");
    expect(text).not.toContain("credentialId");
  });
});
