/**
 * Confirming at the identity provider (#1296), against real Postgres.
 *
 * An account created by single sign-on holds no password, passkey or second
 * factor, so the recent-proof gate in front of token minting had nothing to
 * ask it for. The browser now goes back to the provider with a fresh login
 * request, and the callback stamps the signed-in session's `reproofAt` when
 * the ID token names this account's linked identity and an authentication
 * inside the window. The provider's network legs are stubbed; the state blob,
 * the session binding, the stamp, the gate and the passkey enrollment are
 * real.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-oidc-reproof-32-bytes-minimum-1234567890abcd";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const ISSUER = "https://idp.example.test";
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

vi.mock("@/lib/auth/oidc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/oidc")>();
  return {
    ...actual,
    discoverOidcMetadata: vi.fn(async () => METADATA),
    exchangeCodeForTokens: vi.fn(async () => ({ id_token: "id-token" })),
    verifyIdToken: vi.fn(),
  };
});

const oidc = await import("@/lib/auth/oidc");

const USER_ID = "user-oidc-reproof";
const SUB = "idp-sub-reproof";
const HOUR = 60 * 60 * 1000;
const OIDC_ENV = {
  OIDC_ISSUER_URL: ISSUER,
  OIDC_CLIENT_ID: "client",
  OIDC_CLIENT_SECRET: "secret",
};

type RouteFn = (request: NextRequest) => Promise<Response>;

async function startSession(createdAgoMs: number): Promise<string> {
  const now = Date.now();
  const session = await getPrismaClient().session.create({
    data: {
      userId: USER_ID,
      createdAt: new Date(now - createdAgoMs),
      expiresAt: new Date(now + HOUR),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return session.id;
}

/** The provider says it authenticated `sub` this many seconds ago. */
function providerSays(sub: string, secondsAgo: number) {
  vi.mocked(oidc.verifyIdToken).mockResolvedValue({
    sub,
    email: "sso@example.test",
    emailVerified: true,
    name: null,
    authTime: Math.floor(Date.now() / 1000) - secondsAgo,
  });
}

async function startReproof(next: string) {
  const { GET } = await import("@/app/api/auth/oidc/reproof/route");
  const res = await (GET as unknown as RouteFn)(
    new NextRequest(
      `http://localhost:3000/api/auth/oidc/reproof?next=${encodeURIComponent(next)}`,
    ),
  );
  return res as Response & { cookies?: unknown };
}

/** Run the start, then come back through the callback with the browser's cookies. */
async function roundTrip(next: string, sessionCookie: string) {
  const started = await startReproof(next);
  expect(started.status).toBe(307);
  const authorize = new URL(started.headers.get("location")!);
  const stateCookie = /oidc_auth_state=([^;]+)/.exec(
    started.headers.get("set-cookie") ?? "",
  )?.[1];
  expect(stateCookie).toBeTruthy();

  const { GET } = await import("@/app/api/auth/oidc/callback/route");
  const res = await (GET as unknown as RouteFn)(
    new NextRequest(
      `http://localhost:3000/api/auth/oidc/callback?code=abc&state=${authorize.searchParams.get("state")}`,
      {
        headers: {
          cookie: `oidc_auth_state=${stateCookie}; healthlog_session=${sessionCookie}`,
        },
      },
    ),
  );
  return { authorize, res };
}

async function mintMeasurementToken() {
  const { POST } = await import("@/app/api/tokens/measurements/route");
  return (POST as unknown as RouteFn)(
    new NextRequest("http://localhost:3000/api/tokens/measurements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "shortcut" }),
    }),
  );
}

async function reproofAtOf(sessionId: string) {
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
    select: { reproofAt: true, mfaVerifiedAt: true },
  });
  return row;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  Object.assign(process.env, OIDC_ENV);
  process.env.APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "sso-only",
      email: "sso@example.test",
      role: "USER",
      oidcIssuer: ISSUER,
      oidcSub: SUB,
      onboardingCompletedAt: new Date(),
    },
  });
});

afterEach(() => {
  for (const key of Object.keys(OIDC_ENV)) delete process.env[key];
});

describe("confirming at the identity provider", () => {
  it("is what the gate offers an account with nothing else to prove", async () => {
    await startSession(HOUR);
    const refused = await mintMeasurementToken();
    expect(refused.status).toBe(401);
    const body = (await refused.json()) as {
      meta?: { errorCode?: string; methods?: string[] };
    };
    expect(body.meta?.errorCode).toBe("auth.reproof.required");
    expect(body.meta?.methods).toEqual(["oidc"]);
  });

  it("asks the provider for a fresh, timed sign-in with state, nonce and PKCE", async () => {
    await startSession(HOUR);
    const started = await startReproof("/settings/api");
    const authorize = new URL(started.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      METADATA.authorization_endpoint,
    );
    expect(authorize.searchParams.get("prompt")).toBe("login");
    expect(authorize.searchParams.get("max_age")).toBe("0");
    expect(authorize.searchParams.get("state")).toBeTruthy();
    expect(authorize.searchParams.get("nonce")).toBeTruthy();
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("stamps the session, returns to the page and lets the token mint", async () => {
    const sessionId = await startSession(HOUR);
    providerSays(SUB, 10);
    const { res } = await roundTrip("/settings/api?tab=tokens", sessionId);
    expect(res.status).toBe(307);
    const back = new URL(res.headers.get("location")!);
    expect(back.pathname).toBe("/settings/api");
    expect(back.searchParams.get("tab")).toBe("tokens");
    expect(back.searchParams.get("reproof")).toBe("done");

    const row = await reproofAtOf(sessionId);
    expect(row.reproofAt).not.toBeNull();
    expect(row.mfaVerifiedAt).toBeNull();
    // No session was created or switched.
    expect(await getPrismaClient().session.count()).toBe(1);
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: USER_ID, action: "auth.reproof.succeeded" },
      }),
    ).toBe(1);

    const minted = await mintMeasurementToken();
    expect(minted.status).toBe(201);
  });

  it("then lets the account enroll a passkey", async () => {
    const sessionId = await startSession(HOUR);
    const { POST } =
      await import("@/app/api/auth/passkey/register-options/route");
    const begin = () =>
      (POST as unknown as RouteFn)(
        new NextRequest(
          "http://localhost:3000/api/auth/passkey/register-options",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ method: "oidc" }),
          },
        ),
      );

    const before = await begin();
    expect(before.status).toBe(401);
    expect(
      ((await before.json()) as { meta?: { methods?: string[] } }).meta
        ?.methods,
    ).toEqual(["oidc"]);

    providerSays(SUB, 10);
    await roundTrip("/settings/security", sessionId);

    const after = await begin();
    expect(after.status).toBe(200);
    const begun = (await after.json()) as {
      data: { challengeId: string; options: { challenge: string } };
    };
    expect(begun.data.challengeId).toBeTruthy();
    expect(begun.data.options.challenge).toBeTruthy();
  });

  it("refuses a provider sign-in older than the window", async () => {
    const sessionId = await startSession(HOUR);
    providerSays(SUB, 60 * 60);
    const { res } = await roundTrip("/settings/api", sessionId);
    expect(
      new URL(res.headers.get("location")!).searchParams.get("reproof"),
    ).toBe("failed");
    expect((await reproofAtOf(sessionId)).reproofAt).toBeNull();
    expect((await mintMeasurementToken()).status).toBe(401);
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: USER_ID, action: "auth.mfa.failed" },
      }),
    ).toBe(1);
  });

  it("refuses a different subject at the same provider", async () => {
    const sessionId = await startSession(HOUR);
    providerSays("someone-else", 10);
    const { res } = await roundTrip("/settings/api", sessionId);
    expect(
      new URL(res.headers.get("location")!).searchParams.get("reproof"),
    ).toBe("failed");
    expect((await reproofAtOf(sessionId)).reproofAt).toBeNull();
    expect((await mintMeasurementToken()).status).toBe(401);
  });

  it("stamps nothing and spends nothing when the browser comes back with another session", async () => {
    const sessionId = await startSession(HOUR);
    const other = await getPrismaClient().session.create({
      data: { userId: USER_ID, expiresAt: new Date(Date.now() + HOUR) },
    });
    providerSays(SUB, 10);
    const { res } = await roundTrip("/settings/api", other.id);
    expect(
      new URL(res.headers.get("location")!).searchParams.get("reproof"),
    ).toBe("failed");
    expect(oidc.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect((await reproofAtOf(sessionId)).reproofAt).toBeNull();
    expect((await reproofAtOf(other.id)).reproofAt).toBeNull();
  });

  it("is not offered to an account with a second factor", async () => {
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { totpConfirmedAt: new Date() },
    });
    await startSession(HOUR);
    const started = await startReproof("/settings/api");
    const back = new URL(started.headers.get("location")!);
    expect(back.origin).toBe("http://localhost:3000");
    expect(back.searchParams.get("reproof")).toBe("failed");
    expect(oidc.discoverOidcMetadata).not.toHaveBeenCalled();
  });
});
