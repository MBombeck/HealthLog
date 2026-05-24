/**
 * v1.4.47 W6 — end-to-end coverage for the new Withings OAuth state
 * ledger.
 *
 * The audit's L-1 recommendation was a fully-random nonce backed by a
 * `(nonce → userId)` ledger row, single-use semantics, with the
 * cookie carrying only the opaque nonce. This file pins the
 * connect → callback handshake end-to-end against real Postgres:
 *
 *   1. `withings/connect` mints a row and stamps the cookie.
 *   2. `withings/callback` resolves the user via the row's `userId`,
 *      verifies it matches the session, and deletes the row.
 *   3. A second callback with the same nonce hits the "row not
 *      found" branch and redirects to the error page (replay
 *      protection).
 *   4. A callback whose row has expired hits the same branch.
 *   5. The connect handler refuses to start when the user has no
 *      Withings credentials — no ledger row is minted.
 *
 * Sibling assertions in `withings-oauth.test.ts` already cover the
 * token-exchange happy path + the `disconnect` route; this file
 * focuses on the ledger lifecycle the audit flagged.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

const TEST_USER_ID = "user-withings-oauth-flow";

const WITHINGS_OAUTH_URL =
  "https://account.withings.com/oauth2_user/authorize2";
const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_NOTIFY_URL = "https://wbsapi.withings.net/notify";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();

  const { encrypt } = await import("@/lib/crypto");
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "withings-flow-user",
      email: "withings-flow@example.test",
      role: "USER",
      withingsClientIdEncrypted: encrypt("client-id-flow"),
      withingsClientSecretEncrypted: encrypt("client-secret-flow"),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);

  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Withings OAuth nonce ledger (real Postgres)", () => {
  it("connect mints exactly one row keyed on the URL state, with `userId` + 10-min TTL", async () => {
    const { GET } = await import("@/app/api/withings/connect/route");
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/withings/connect"),
    );

    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain(WITHINGS_OAUTH_URL);
    const target = new URL(location);
    const state = target.searchParams.get("state")!;

    // 22-char base64url. The legacy `${userId}:${random16}` shape no
    // longer reaches the URL — the audit L-1 fix.
    expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(state).not.toContain(":");
    expect(state).not.toContain(TEST_USER_ID);

    const prisma = getPrismaClient();
    const rows = await prisma.withingsOAuthState.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].nonce).toBe(state);
    expect(rows[0].userId).toBe(TEST_USER_ID);
    // TTL is 10 minutes; allow a generous floor so a slow CI box
    // doesn't flake on the upper bound.
    const ttlMs = rows[0].expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 5_000);

    // Cookie carries the same opaque nonce — no user id.
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`withings_state=${state}`);
    expect(setCookie).not.toContain(TEST_USER_ID);
  });

  it("connect refuses (400) when the user has no Withings credentials — no ledger row minted", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: TEST_USER_ID },
      data: {
        withingsClientIdEncrypted: null,
        withingsClientSecretEncrypted: null,
      },
    });

    const { GET } = await import("@/app/api/withings/connect/route");
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/withings/connect"),
    );

    expect(res.status).toBe(400);
    const rows = await prisma.withingsOAuthState.findMany();
    expect(rows).toHaveLength(0);
  });

  it("connect → callback consumes the row (single-use); replay of the same nonce hits the error page", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === WITHINGS_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            status: 0,
            body: {
              userid: "withings-userid-flow",
              access_token: "access-flow",
              refresh_token: "refresh-flow",
              expires_in: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === WITHINGS_NOTIFY_URL) {
        return new Response(JSON.stringify({ status: 0 }), { status: 200 });
      }
      throw new Error(`Unexpected fetch in flow test: ${url}`);
    });

    // Leg 1 — connect
    const { GET: connect } = await import("@/app/api/withings/connect/route");
    const connectRes = await (
      connect as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/withings/connect"));
    const location = connectRes.headers.get("location")!;
    const nonce = new URL(location).searchParams.get("state")!;

    const prisma = getPrismaClient();
    const beforeCallback = await prisma.withingsOAuthState.findUnique({
      where: { nonce },
    });
    expect(beforeCallback).not.toBeNull();

    // Leg 2 — callback (happy path)
    const { GET: callback } = await import("@/app/api/withings/callback/route");
    const callbackReq = new NextRequest(
      `http://localhost/api/withings/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
      {
        method: "GET",
        headers: {
          cookie: `healthlog_session=${cookieJar.get("healthlog_session")}; withings_state=${nonce}`,
        },
      },
    );
    const callbackRes = await callback(callbackReq);
    expect(callbackRes.status).toBe(307);
    expect(callbackRes.headers.get("location")).toContain(
      "withings=connected",
    );

    const afterCallback = await prisma.withingsOAuthState.findUnique({
      where: { nonce },
    });
    expect(afterCallback).toBeNull();

    // Leg 3 — replay the same nonce. The cookie compare still passes
    // (matching strings) but the row lookup misses, so the handler
    // bounces to the error page without hitting the token endpoint
    // again.
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();
    const replayReq = new NextRequest(
      `http://localhost/api/withings/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
      {
        method: "GET",
        headers: {
          cookie: `healthlog_session=${cookieJar.get("healthlog_session")}; withings_state=${nonce}`,
        },
      },
    );
    const replayRes = await callback(replayReq);
    expect(replayRes.status).toBe(307);
    expect(replayRes.headers.get("location")).toContain(
      "withings=error&reason=replay",
    );
    // No token-endpoint call on the replay leg.
    const replayTokenCalls = fetchSpy.mock.calls.filter(
      ([input]) =>
        (typeof input === "string" ? input : (input as Request).url) ===
        WITHINGS_TOKEN_URL,
    );
    expect(replayTokenCalls).toHaveLength(0);
  });

  it("callback rejects an expired row, deletes it, and never reaches the token exchange", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("must not be called", { status: 500 }));

    const nonce = "expired-nonce-22charXX";
    const prisma = getPrismaClient();
    await prisma.withingsOAuthState.create({
      data: {
        nonce,
        userId: TEST_USER_ID,
        expiresAt: new Date(Date.now() - 60_000), // already expired
      },
    });

    const { GET: callback } = await import("@/app/api/withings/callback/route");
    const req = new NextRequest(
      `http://localhost/api/withings/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
      {
        method: "GET",
        headers: {
          cookie: `healthlog_session=${cookieJar.get("healthlog_session")}; withings_state=${nonce}`,
        },
      },
    );
    const res = await callback(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=expired",
    );

    // Token endpoint never hit.
    expect(fetchSpy).not.toHaveBeenCalled();

    // The handler stamps out the expired row so a clock-skewed replay
    // can't slip through.
    const lingering = await prisma.withingsOAuthState.findUnique({
      where: { nonce },
    });
    expect(lingering).toBeNull();
  });

  it("callback rejects a row whose userId does not match the session, deletes it, and writes no connection", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("must not be called", { status: 500 }));

    // Seed a second user + a ledger row that points to *them*. The
    // callback runs under TEST_USER_ID's session, so the row's userId
    // mismatch must trip the rejection branch.
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        id: "user-other-flow",
        username: "other-user",
        email: "other@example.test",
        role: "USER",
      },
    });
    const nonce = "cross-user-noncexxxxxx";
    await prisma.withingsOAuthState.create({
      data: {
        nonce,
        userId: "user-other-flow",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const { GET: callback } = await import("@/app/api/withings/callback/route");
    const req = new NextRequest(
      `http://localhost/api/withings/callback?code=auth-code&state=${encodeURIComponent(nonce)}`,
      {
        method: "GET",
        headers: {
          cookie: `healthlog_session=${cookieJar.get("healthlog_session")}; withings_state=${nonce}`,
        },
      },
    );
    const res = await callback(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=cross_user",
    );
    // No token-endpoint call — short-circuited before exchangeCode fires.
    // (Unrelated transports may still hit `fetch` for wide-event shipping;
    // we narrow to the Withings token URL the same way the replay leg
    // above does so the assertion stays meaningful without coupling to
    // logging-transport details.)
    const crossUserTokenCalls = fetchSpy.mock.calls.filter(
      ([input]) =>
        (typeof input === "string" ? input : (input as Request).url) ===
        WITHINGS_TOKEN_URL,
    );
    expect(crossUserTokenCalls).toHaveLength(0);

    // The row is stamped out — single-use + cross-user mismatch is a
    // CSRF signal, not a recoverable state, so we don't leave the
    // row around for a retry.
    const lingering = await prisma.withingsOAuthState.findUnique({
      where: { nonce },
    });
    expect(lingering).toBeNull();

    // No connection landed under EITHER user.
    expect(
      await prisma.withingsConnection.findUnique({
        where: { userId: TEST_USER_ID },
      }),
    ).toBeNull();
    expect(
      await prisma.withingsConnection.findUnique({
        where: { userId: "user-other-flow" },
      }),
    ).toBeNull();
  });
});
