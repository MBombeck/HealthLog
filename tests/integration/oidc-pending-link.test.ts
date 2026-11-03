/**
 * A single sign-on identity is linked to an existing account only after the
 * account's own credential is proved in the same browser.
 *
 * The callback leaves a sealed pending link (unit-tested in the callback's own
 * suite); this pins the other half against real Postgres: which sign-ins
 * complete it, which do not, and that an SSO-only policy opens the password
 * form for exactly the account the IdP vouched for and nothing else.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { bodyWithoutRequestId } from "@/__tests__/helpers/error-envelope";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-oidc-pending-link-32-bytes-minimum-1234567890";

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

const { hashPassword } = await import("@/lib/auth/password");
const { encrypt } = await import("@/lib/crypto");

const PASSWORD = "Correct horse battery staple!42";
const ISSUER = "https://idp.example.test";
const OIDC_ENV = {
  OIDC_ISSUER_URL: ISSUER,
  OIDC_CLIENT_ID: "client",
  OIDC_CLIENT_SECRET: "secret",
};

function pendingLinkFor(userId: string, expiresInMs = 60_000): void {
  cookieJar.set(
    "hl_oidc_link",
    encrypt(
      JSON.stringify({
        u: userId,
        i: ISSUER,
        s: "idp-sub-1",
        e: Date.now() + expiresInMs,
      }),
    ),
  );
}

async function passwordLogin(identifier: string, password = PASSWORD) {
  const { POST } = await import("@/app/api/auth/login/route");
  return POST(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: identifier, password }),
    }),
  );
}

async function linkOf(id: string) {
  return getPrismaClient().user.findUniqueOrThrow({
    where: { id },
    select: { oidcIssuer: true, oidcSub: true },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  process.env.APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  const hash = await hashPassword(PASSWORD);
  await getPrismaClient().user.createMany({
    data: [
      {
        id: "acct-a",
        username: "acct-a",
        email: "a@example.test",
        passwordHash: hash,
        onboardingCompletedAt: new Date(),
      },
      {
        id: "acct-b",
        username: "acct-b",
        email: "b@example.test",
        passwordHash: hash,
        onboardingCompletedAt: new Date(),
      },
    ],
  });
});

afterEach(() => {
  for (const key of [...Object.keys(OIDC_ENV), "OIDC_ONLY"]) {
    delete process.env[key];
  }
});

describe("pending single sign-on link", () => {
  it("is completed by a password sign-in to the named account", async () => {
    pendingLinkFor("acct-a");
    const res = await passwordLogin("acct-a");
    expect(res.status).toBe(200);
    expect(await linkOf("acct-a")).toEqual({
      oidcIssuer: ISSUER,
      oidcSub: "idp-sub-1",
    });
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: "acct-a", action: "auth.oidc.linked" },
      }),
    ).toBe(1);
  });

  it("is not completed by a sign-in to a different account", async () => {
    pendingLinkFor("acct-a");
    const res = await passwordLogin("acct-b");
    expect(res.status).toBe(200);
    expect(await linkOf("acct-a")).toEqual({ oidcIssuer: null, oidcSub: null });
    expect(await linkOf("acct-b")).toEqual({ oidcIssuer: null, oidcSub: null });
  });

  it("is not completed by a wrong password", async () => {
    pendingLinkFor("acct-a");
    const res = await passwordLogin("acct-a", "not the password");
    expect(res.status).toBe(401);
    expect(await linkOf("acct-a")).toEqual({ oidcIssuer: null, oidcSub: null });
  });

  it("expires", async () => {
    pendingLinkFor("acct-a", -1);
    await passwordLogin("acct-a");
    expect(await linkOf("acct-a")).toEqual({ oidcIssuer: null, oidcSub: null });
  });

  it("refuses a forged cookie", async () => {
    cookieJar.set(
      "hl_oidc_link",
      JSON.stringify({ u: "acct-a", i: ISSUER, s: "x", e: Date.now() + 1e6 }),
    );
    await passwordLogin("acct-a");
    expect(await linkOf("acct-a")).toEqual({ oidcIssuer: null, oidcSub: null });
  });
});

describe("under an SSO-only policy", () => {
  beforeEach(() => {
    Object.assign(process.env, OIDC_ENV, { OIDC_ONLY: "true" });
  });

  it("keeps password sign-in closed without a pending link", async () => {
    const res = await passwordLogin("acct-a");
    expect(res.status).toBe(403);
  });

  it("opens it for the account the pending link names, and links it", async () => {
    pendingLinkFor("acct-a");
    const res = await passwordLogin("acct-a");
    expect(res.status).toBe(200);
    expect((await linkOf("acct-a")).oidcSub).toBe("idp-sub-1");
  });

  it("answers the same for another account's right and wrong password", async () => {
    // Refused before the password is checked, so the exception cannot be
    // used to test passwords of accounts the link does not name.
    pendingLinkFor("acct-a");
    const right = await passwordLogin("acct-b");
    const wrong = await passwordLogin("acct-b", "not the password");
    expect(right.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(await bodyWithoutRequestId(wrong)).toBe(
      await bodyWithoutRequestId(right),
    );
  });

  it("keeps it closed for any other account", async () => {
    pendingLinkFor("acct-a");
    const res = await passwordLogin("acct-b");
    expect(res.status).toBe(403);
    expect(
      await getPrismaClient().session.count({ where: { userId: "acct-b" } }),
    ).toBe(0);
  });
});
