/**
 * A Bearer decides who is calling, and a token client is never handed a web
 * session cookie. Real Postgres, real resolvers, real routes.
 *
 * The native client keeps every cookie it is sent in a shared store and
 * replays it beside its token. Three routes used to hand it a session cookie
 * (the password change, registration, the passkey sign-in), and the resolver
 * read the cookie before the token. After a password change and a sign-out, a
 * second account signing in on the same device could run as the first. Each
 * case below fails on the tree before the fix.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

/** Every cookie name the code under test wrote, expiries included. */
const cookieWrites = vi.hoisted(() => [] as string[]);

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
      set: (name: string, value: string, options?: { maxAge?: number }) => {
        cookieWrites.push(name);
        if (value === "" || options?.maxAge === 0) cookieJar.delete(name);
        else cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

// The signature check is the one piece a test cannot produce honestly; the
// challenge, the account and the issuance all run.
vi.mock("@/lib/auth/passkey", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/passkey")>(
      "@/lib/auth/passkey",
    );
  return { ...actual, verifyAuthentication: vi.fn() };
});

const { hashToken } = await import("@/lib/auth/hmac");
const { hashPassword } = await import("@/lib/auth/password");

const APP = "http://localhost:3000";
const NATIVE = {
  "user-agent": "HealthLog-iOS/1.7 CFNetwork",
  "x-device-id": "device-1",
};
const PASSWORD = "OldStrongP@ssw0rd!123abc";
const NEW_PASSWORD = "NewStrongP@ssw0rd!456xyz";
const SESSION_COOKIE = "healthlog_session";
const HINT_COOKIES = ["hl_onboarding", "hl_mfa_enroll"];

type RouteFn = (request: NextRequest) => Promise<Response>;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  cookieWrites.length = 0;
});

async function seedUser(name: string, role: "USER" | "ADMIN" = "USER") {
  return getPrismaClient().user.create({
    data: {
      username: name,
      email: `${name}@example.test`,
      role,
      timezone: "UTC",
      passwordHash: await hashPassword(PASSWORD),
      onboardingCompletedAt: new Date(),
    },
  });
}

/**
 * A live web session for `userId`, its secret placed in the cookie jar. Two
 * days from expiry, so a cookie read would slide it and re-issue the cookie.
 */
async function seedCookieSession(userId: string): Promise<string> {
  const secret = `hls_${hexOf(userId)}${"c".repeat(32)}`;
  const row = await getPrismaClient().session.create({
    data: {
      userId,
      tokenHash: hashToken(secret),
      expiresAt: new Date(Date.now() + 2 * 24 * 3600_000),
    },
  });
  cookieJar.set(SESSION_COOKIE, secret);
  return row.id;
}

/** 32 hex characters derived from `seed`, so each fixture's secret differs. */
function hexOf(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** A device login for `userId`: a wildcard access token and its refresh row. */
async function seedBearer(
  userId: string,
  permissions: string[] = ["*"],
): Promise<string> {
  const raw = `hlk_${hexOf(userId + permissions.join())}${"b".repeat(32)}`;
  await getPrismaClient().apiToken.create({
    data: { userId, name: "device", tokenHash: hashToken(raw), permissions },
  });
  await getPrismaClient().refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(`hlr_${raw.slice(4)}`),
      accessTokenHash: hashToken(raw),
      deviceId: "device-1",
      expiresAt: new Date(Date.now() + 60 * 24 * 3600_000),
    },
  });
  return raw;
}

/**
 * A request as the route sees it. The headers go on the request AND into the
 * `next/headers` jar, which is where the resolvers read them.
 */
function request(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): NextRequest {
  for (const [k, v] of Object.entries(headers)) {
    headerJar.set(k.toLowerCase(), v);
  }
  return new NextRequest(`${APP}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  modulePath: string,
  method: "GET" | "POST",
  req: NextRequest,
): Promise<Response> {
  const mod = (await import(modulePath)) as Record<string, RouteFn>;
  return mod[method](req);
}

async function json(res: Response): Promise<{
  data: Record<string, unknown> | null;
  error: unknown;
  meta?: { errorCode?: string };
}> {
  return (await res.json()) as never;
}

describe("a session cookie beside a Bearer", () => {
  it("of ANOTHER account is refused with 401, and that session is ended", async () => {
    const a = await seedUser("account-a");
    const b = await seedUser("account-b");
    const sessionA = await seedCookieSession(a.id);
    const tokenB = await seedBearer(b.id);

    const res = await call(
      "@/app/api/auth/me/route",
      "GET",
      request("GET", "/api/auth/me", {
        ...NATIVE,
        authorization: `Bearer ${tokenB}`,
      }),
    );

    expect(res.status).toBe(401);
    const body = await json(res);
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("auth.token.invalid");
    // The stray session is gone server-side and expired in the client's jar.
    expect(
      await getPrismaClient().session.findUnique({ where: { id: sessionA } }),
    ).toBeNull();
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);

    // The next attempt carries the token alone and runs as B.
    const retry = await call(
      "@/app/api/auth/me/route",
      "GET",
      request("GET", "/api/auth/me", {
        ...NATIVE,
        authorization: `Bearer ${tokenB}`,
      }),
    );
    expect(retry.status).toBe(200);
    expect(((await json(retry)).data as { id: string }).id).toBe(b.id);
  });

  it("of the SAME account runs as the Bearer, sets no cookie, and keeps the session", async () => {
    const a = await seedUser("account-a");
    const sessionA = await seedCookieSession(a.id);
    const tokenA = await seedBearer(a.id);

    const res = await call(
      "@/app/api/auth/me/route",
      "GET",
      request("GET", "/api/auth/me", {
        ...NATIVE,
        authorization: `Bearer ${tokenA}`,
      }),
    );

    expect(res.status).toBe(200);
    expect(((await json(res)).data as { id: string }).id).toBe(a.id);
    // Nothing written: no sliding re-issue of the session, no hint cookies.
    expect(cookieWrites).toEqual([]);
    expect(
      await getPrismaClient().session.findUnique({ where: { id: sessionA } }),
    ).not.toBeNull();
  });

  it("does not widen a narrow Bearer to the cookie's reach", async () => {
    const a = await seedUser("account-a");
    await seedCookieSession(a.id);
    const narrow = await seedBearer(a.id, ["medication:ingest"]);

    // `/api/auth/me` declares no scope: a narrow token is refused there, and a
    // cookie of the same account riding along does not lift that.
    const res = await call(
      "@/app/api/auth/me/route",
      "GET",
      request("GET", "/api/auth/me", {
        ...NATIVE,
        authorization: `Bearer ${narrow}`,
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).meta?.errorCode).toBe("auth.scope.insufficient");
  });

  it("never reaches an admin surface, even when the cookie is an admin's own", async () => {
    const admin = await seedUser("account-admin", "ADMIN");
    await seedCookieSession(admin.id);
    const token = await seedBearer(admin.id);

    const viaBoth = await call(
      "@/app/api/admin/settings/route",
      "GET",
      request("GET", "/api/admin/settings", {
        ...NATIVE,
        authorization: `Bearer ${token}`,
      }),
    );
    expect(viaBoth.status).toBe(401);

    // The same cookie alone is an admin.
    headerJar.clear();
    const viaCookie = await call(
      "@/app/api/admin/settings/route",
      "GET",
      request("GET", "/api/admin/settings"),
    );
    expect(viaCookie.status).toBe(200);
  });

  it("keys an idempotent replay to the Bearer's account, not the cookie's", async () => {
    const a = await seedUser("account-a");
    const b = await seedUser("account-b");
    await seedCookieSession(a.id);
    const tokenB = await seedBearer(b.id);
    headerJar.set("authorization", `Bearer ${tokenB}`);

    const { defaultUserIdResolver } = await import("@/lib/idempotency");
    expect(await defaultUserIdResolver()).toBe(b.id);
  });
});

describe("no web session cookie for a token client", () => {
  it("a Bearer password change answers with a fresh pair and no cookie", async () => {
    const a = await seedUser("account-a");
    const tokenA = await seedBearer(a.id);

    const res = await call(
      "@/app/api/auth/password/route",
      "POST",
      request(
        "POST",
        "/api/auth/password",
        { ...NATIVE, authorization: `Bearer ${tokenA}` },
        {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        },
      ),
    );

    expect(res.status).toBe(200);
    const data = (await json(res)).data as {
      changed: boolean;
      token?: string;
      refreshToken?: string;
      tokenExpiresAt?: string;
      refreshTokenExpiresAt?: string;
    };
    expect(data.changed).toBe(true);
    expect(data.token).toMatch(/^hlk_/);
    expect(data.refreshToken).toMatch(/^hlr_/);
    expect(data.tokenExpiresAt).toBeTruthy();
    expect(data.refreshTokenExpiresAt).toBeTruthy();

    // No cookie and no web session.
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    for (const name of HINT_COOKIES) expect(cookieJar.has(name)).toBe(false);
    expect(await getPrismaClient().session.count()).toBe(0);

    // The old pair is revoked; the new pair is the account's only live
    // device login, bound to the calling device.
    const prisma = getPrismaClient();
    expect(
      (
        await prisma.apiToken.findUnique({
          where: { tokenHash: hashToken(tokenA) },
        })
      )?.revoked,
    ).toBe(true);
    const live = await prisma.refreshToken.findMany({
      where: { userId: a.id, revokedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].accessTokenHash).toBe(hashToken(data.token!));
    expect(live[0].deviceId).toBe("device-1");

    // And it works.
    headerJar.clear();
    const me = await call(
      "@/app/api/auth/me/route",
      "GET",
      request("GET", "/api/auth/me", {
        ...NATIVE,
        authorization: `Bearer ${data.token}`,
      }),
    );
    expect(me.status).toBe(200);
  });

  it("a cookie password change still rotates the session cookie", async () => {
    const a = await seedUser("account-a");
    const before = await seedCookieSession(a.id);
    const oldSecret = cookieJar.get(SESSION_COOKIE);

    const res = await call(
      "@/app/api/auth/password/route",
      "POST",
      request(
        "POST",
        "/api/auth/password",
        { "user-agent": "Mozilla/5.0 Safari/605.1.15" },
        {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          confirmPassword: NEW_PASSWORD,
        },
      ),
    );

    expect(res.status).toBe(200);
    const data = (await json(res)).data as Record<string, unknown>;
    expect(data).toEqual({ changed: true });
    const sessions = await getPrismaClient().session.findMany({
      where: { userId: a.id },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).not.toBe(before);
    expect(cookieJar.get(SESSION_COOKIE)).not.toBe(oldSecret);
    expect(sessions[0].tokenHash).toBe(
      hashToken(cookieJar.get(SESSION_COOKIE)!),
    );
  });

  it("a native passkey sign-in gets tokens and no cookie", async () => {
    const a = await seedUser("account-a");
    const { verifyAuthentication } = await import("@/lib/auth/passkey");
    vi.mocked(verifyAuthentication).mockResolvedValue({
      verification: { verified: true },
      passkey: { userId: a.id },
    } as never);

    const res = await call(
      "@/app/api/auth/passkey/login-verify/route",
      "POST",
      request("POST", "/api/auth/passkey/login-verify", NATIVE, {
        challengeId: "challenge-1",
        credential: { id: "credential-1" },
      }),
    );

    expect(res.status).toBe(200);
    const data = (await json(res)).data as {
      token?: string;
      refreshToken?: string;
    };
    expect(data.token).toMatch(/^hlk_/);
    expect(data.refreshToken).toMatch(/^hlr_/);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    for (const name of HINT_COOKIES) expect(cookieJar.has(name)).toBe(false);
    expect(await getPrismaClient().session.count()).toBe(0);
  });

  it("a native registration writes no session and sets no cookie", async () => {
    // Not the first account: that one needs the operator's setup token.
    await seedUser("existing-account");
    const res = await call(
      "@/app/api/auth/register/route",
      "POST",
      request("POST", "/api/auth/register", NATIVE, {
        username: "fresh-account",
        email: "fresh-account@example.test",
        password: NEW_PASSWORD,
      }),
    );

    expect(res.status).toBe(201);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    for (const name of HINT_COOKIES) expect(cookieJar.has(name)).toBe(false);
    expect(await getPrismaClient().session.count()).toBe(0);
  });

  it("a browser registration still gets its session cookie", async () => {
    // Not the first account: that one needs the operator's setup token.
    await seedUser("existing-account");
    const res = await call(
      "@/app/api/auth/register/route",
      "POST",
      request(
        "POST",
        "/api/auth/register",
        { "user-agent": "Mozilla/5.0 Safari/605.1.15" },
        {
          username: "fresh-browser",
          email: "fresh-browser@example.test",
          password: NEW_PASSWORD,
        },
      ),
    );

    expect(res.status).toBe(201);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(true);
    expect(await getPrismaClient().session.count()).toBe(1);
  });
});
