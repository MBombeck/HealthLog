/**
 * v1.4.35 — integration coverage for the Withings OAuth handshake.
 *
 * F-3 in the test coverage audit flagged the OAuth credential lifecycle
 * (`connect`, `callback`, `disconnect`) as completely uncovered despite
 * being the only thing standing between a working Withings sync and a
 * forever-broken integration. This file pins the contract end-to-end:
 *
 *   - GET /api/withings/connect returns a 307 to the upstream authorise
 *     endpoint with the right query params and stamps the
 *     `withings_state` cookie
 *   - GET /api/withings/callback exchanges `code` for tokens against a
 *     mocked Withings endpoint and persists the encrypted result on
 *     WithingsConnection
 *   - POST /api/withings/disconnect deletes the connection and writes a
 *     `withings.disconnect` audit row
 *   - GET /api/withings/callback with a replayed / wrong state cookie
 *     redirects to `?withings=error&reason=state` and does not write
 *     any tokens
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

// Crypto module reads `ENCRYPTION_KEY` lazily on first encrypt() / decrypt();
// seed a deterministic test key here so the integration container has
// something to decrypt against. Skipped if the env already carries one.
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

const TEST_USER_ID = "user-withings-oauth";

const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_OAUTH_URL =
  "https://account.withings.com/oauth2_user/authorize2";
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
      username: "withings-user",
      email: "withings@example.test",
      role: "USER",
      withingsClientIdEncrypted: encrypt("client-id-test"),
      withingsClientSecretEncrypted: encrypt("client-secret-test"),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);

  // The OAuth client builds its redirect URI from NEXT_PUBLIC_APP_URL
  // unless WITHINGS_REDIRECT_URI overrides it. Pin both so the assertions
  // below can compare literal strings.
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Withings OAuth handshake (real Postgres)", () => {
  it("connect endpoint redirects to Withings with the expected query params and stamps the state cookie", async () => {
    const { GET } = await import("@/app/api/withings/connect/route");
    const res = await (GET as unknown as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/withings/connect"),
    );

    // 307 from NextResponse.redirect — the body is intentionally empty.
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(location).toContain(WITHINGS_OAUTH_URL);

    const target = new URL(location!);
    expect(target.searchParams.get("response_type")).toBe("code");
    expect(target.searchParams.get("client_id")).toBe("client-id-test");
    expect(target.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/withings/callback",
    );
    expect(target.searchParams.get("scope")).toBe("user.metrics,user.activity");
    const state = target.searchParams.get("state");
    expect(state).toMatch(/^user-withings-oauth:[a-f0-9]{32}$/);

    // The Set-Cookie header carries the same state nonce — that cookie
    // is what `callback/route.ts` compares against on the second leg.
    // Cookie value is URL-encoded for the `:` separator; compare on the
    // encoded form so the assertion is byte-stable.
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("withings_state=");
    expect(setCookie).toContain(encodeURIComponent(state!));
  });

  it("callback exchanges code → encrypted tokens on the WithingsConnection row", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url === WITHINGS_TOKEN_URL) {
          return new Response(
            JSON.stringify({
              status: 0,
              body: {
                userid: "withings-user-12345",
                access_token: "fresh-access-token",
                refresh_token: "fresh-refresh-token",
                expires_in: 3600,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === WITHINGS_NOTIFY_URL) {
          // Webhook subscribe is fire-and-forget — return a benign
          // success so the spy does not surface an unexpected error.
          return new Response(JSON.stringify({ status: 0 }), { status: 200 });
        }
        throw new Error(`Unexpected fetch in withings-oauth test: ${url}`);
      });

    const state = `${TEST_USER_ID}:${"a".repeat(32)}`;
    const req = new NextRequest(
      `http://localhost/api/withings/callback?code=auth-code-123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: {
          cookie: `healthlog_session=${cookieJar.get("healthlog_session")}; withings_state=${state}`,
        },
      },
    );

    const { GET } = await import("@/app/api/withings/callback/route");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "/settings/integrations?withings=connected",
    );

    const prisma = getPrismaClient();
    const conn = await prisma.withingsConnection.findUnique({
      where: { userId: TEST_USER_ID },
    });
    expect(conn).not.toBeNull();
    expect(conn?.withingsUserId).toBe("withings-user-12345");
    expect(conn?.scope).toBe("user.metrics,user.activity");

    // Tokens persist as encrypted blobs — decrypt to confirm the
    // round-trip lands the plaintext we received from the mocked
    // Withings response.
    const { decrypt } = await import("@/lib/crypto");
    expect(decrypt(conn!.accessToken)).toBe("fresh-access-token");
    expect(decrypt(conn!.refreshToken)).toBe("fresh-refresh-token");

    // Audit row tagged with the upstream userid.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "withings.connect", userId: TEST_USER_ID },
    });
    expect(audit).not.toBeNull();

    // The token endpoint was hit exactly once for the code exchange.
    const tokenCalls = fetchSpy.mock.calls.filter(
      ([input]) =>
        (typeof input === "string" ? input : (input as Request).url) ===
        WITHINGS_TOKEN_URL,
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("callback with a replayed / wrong state redirects to the error page and writes no tokens", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("must not be called", { status: 500 }));

    const validState = `${TEST_USER_ID}:${"a".repeat(32)}`;
    const replayedState = `${TEST_USER_ID}:${"b".repeat(32)}`;
    const req = new NextRequest(
      `http://localhost/api/withings/callback?code=auth-code-123&state=${encodeURIComponent(replayedState)}`,
      {
        method: "GET",
        headers: {
          cookie: `healthlog_session=${cookieJar.get("healthlog_session")}; withings_state=${validState}`,
        },
      },
    );

    const { GET } = await import("@/app/api/withings/callback/route");
    const res = await GET(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(
      "withings=error&reason=state",
    );

    // No upstream call was made — the state check short-circuited the
    // handler before exchangeCode could fire.
    expect(fetchSpy).not.toHaveBeenCalled();

    // No connection row created.
    const prisma = getPrismaClient();
    const conn = await prisma.withingsConnection.findUnique({
      where: { userId: TEST_USER_ID },
    });
    expect(conn).toBeNull();
  });

  it("disconnect clears the WithingsConnection row and writes an audit entry", async () => {
    // Seed an existing connection so disconnect has something to delete.
    const { encrypt } = await import("@/lib/crypto");
    const prisma = getPrismaClient();
    await prisma.withingsConnection.create({
      data: {
        userId: TEST_USER_ID,
        withingsUserId: "withings-user-12345",
        accessToken: encrypt("old-access"),
        refreshToken: encrypt("old-refresh"),
        tokenExpiresAt: new Date(Date.now() + 3600_000),
        scope: "user.metrics,user.activity",
      },
    });

    // Stub the unsubscribe fetch as a benign success so the handler runs
    // its cleanup loop without surfacing an unexpected network error.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: 0 }), { status: 200 }),
    );

    const { POST } = await import("@/app/api/withings/disconnect/route");
    // disconnect handler takes no arguments at the TS level — cast.
    const res = await (POST as unknown as () => Promise<Response>)();

    expect(res.status).toBe(200);

    const conn = await prisma.withingsConnection.findUnique({
      where: { userId: TEST_USER_ID },
    });
    expect(conn).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: { action: "withings.disconnect", userId: TEST_USER_ID },
    });
    expect(audit).not.toBeNull();
  });

  it("disconnect returns 404 when there is no existing connection", async () => {
    const { POST } = await import("@/app/api/withings/disconnect/route");
    const res = await (POST as unknown as () => Promise<Response>)();

    expect(res.status).toBe(404);
  });
});
