/**
 * A browser that delivers the same OAuth callback twice must cause one code
 * exchange, against real Postgres.
 *
 * Chrome was seen sending `/api/oura/callback` twice with the same code about
 * 150 ms apart. Both requests exchanged the code; the second was refused, and
 * Oura answered the reuse by revoking the token the first exchange had issued,
 * so the first sync failed with 401 everywhere. The callback now claims its
 * state before the exchange: one request exchanges, the other follows it to
 * the same page and touches nothing.
 *
 * Covered for a signed-state flow (Oura) and a ledger flow (Withings), the two
 * shapes every connect callback takes.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "integration-hmac-key-0123456789abcdef0123456789";

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

const USER = "user-oauth-single-use";
const OURA_TOKEN_URL = "https://moi.ouraring.com/oauth/v2/ext/oauth-token";
const OURA_ISS = "https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous";
const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";
const WITHINGS_NOTIFY_URL = "https://wbsapi.withings.net/notify";

/** Long enough that two callbacks fired together overlap at the provider. */
const PROVIDER_LATENCY_MS = 150;

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : (input as Request).url;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  delete process.env.OURA_REDIRECT_URI;

  const { encrypt } = await import("@/lib/crypto");
  await getPrismaClient().user.create({
    data: {
      id: USER,
      username: "oauth-single-use",
      email: "oauth-single-use@example.test",
      role: "USER",
      ouraClientIdEncrypted: encrypt("oura-client"),
      ouraClientSecretEncrypted: encrypt("oura-secret"),
      withingsClientIdEncrypted: encrypt("withings-client"),
      withingsClientSecretEncrypted: encrypt("withings-secret"),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function ouraCallback(state: string, code: string | null = "oura-code") {
  const { GET } = await import("@/app/api/oura/callback/route");
  const params = new URLSearchParams(
    code === null
      ? { error: "access_denied", state, iss: OURA_ISS }
      : { code, state, iss: OURA_ISS },
  );
  return GET(
    new NextRequest(`http://localhost/api/oura/callback?${params}`, {
      method: "GET",
      headers: { cookie: `oura_oauth_state=${state}` },
    }),
  );
}

async function mintOuraState(): Promise<string> {
  const { mintSignedState } = await import("@/lib/oauth/signed-state");
  return mintSignedState("oura", USER);
}

describe("Oura callback delivered twice", () => {
  it("exchanges the code once and sends both requests to the connected page", async () => {
    const tokenCalls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = urlOf(input);
      if (url === OURA_TOKEN_URL) {
        tokenCalls.push(String(init?.body ?? ""));
        await new Promise((r) => setTimeout(r, PROVIDER_LATENCY_MS));
        // A reused code is refused, as Oura does.
        if (tokenCalls.length > 1) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "oura-access",
            refresh_token: "oura-refresh",
            expires_in: 86400,
            scope:
              "extapi:daily extapi:personal extapi:spo2 extapi:heart_health extapi:stress extapi:workout extapi:heartrate",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const state = await mintOuraState();
    const [a, b] = await Promise.all([
      ouraCallback(state),
      ouraCallback(state),
    ]);

    expect(tokenCalls).toHaveLength(1);
    expect(a.headers.get("location")).toContain("oura=connected");
    expect(b.headers.get("location")).toBe(a.headers.get("location"));

    const { decrypt } = await import("@/lib/crypto");
    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: USER },
      select: {
        ouraAccessTokenEncrypted: true,
        ouraRefreshTokenEncrypted: true,
        ouraScopeDenied: true,
      },
    });
    expect(decrypt(user.ouraAccessTokenEncrypted!)).toBe("oura-access");
    expect(decrypt(user.ouraRefreshTokenEncrypted!)).toBe("oura-refresh");
    // Every requested scope was granted, so nothing awaits a reconnect.
    expect(user.ouraScopeDenied).toBeNull();
  });

  it("notes the collections a grant leaves out, straight from the token response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (urlOf(input) !== OURA_TOKEN_URL) throw new Error("unexpected");
      return new Response(
        JSON.stringify({
          access_token: "oura-access",
          refresh_token: "oura-refresh",
          expires_in: 86400,
          scope:
            "extapi:daily extapi:personal extapi:spo2 extapi:heart_health extapi:workout extapi:heartrate",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const res = await ouraCallback(await mintOuraState());

    expect(res.headers.get("location")).toContain("oura=connected");
    const user = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: USER },
      select: { ouraScopeDenied: true },
    });
    expect(user.ouraScopeDenied).toEqual(["resilience"]);
  });

  it("lets both requests see a failed exchange, and a new connect still works", async () => {
    let tokenCalls = 0;
    let refuse = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (urlOf(input) !== OURA_TOKEN_URL) throw new Error("unexpected");
      tokenCalls++;
      await new Promise((r) => setTimeout(r, PROVIDER_LATENCY_MS));
      if (refuse) {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "second-access",
          refresh_token: "second-refresh",
          expires_in: 86400,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const first = await mintOuraState();
    const [a, b] = await Promise.all([
      ouraCallback(first),
      ouraCallback(first),
    ]);
    expect(tokenCalls).toBe(1);
    expect(a.headers.get("location")).toContain("oura=error&reason=token");
    expect(b.headers.get("location")).toBe(a.headers.get("location"));

    // Starting over mints a new state, which is a new claim.
    refuse = false;
    const retry = await ouraCallback(await mintOuraState(), "fresh-code");
    expect(tokenCalls).toBe(2);
    expect(retry.headers.get("location")).toContain("oura=connected");
  });
});

describe("Oura consent denied, then allowed", () => {
  it("still exchanges the code when the person returns to the same authorize URL", async () => {
    let tokenCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (urlOf(input) !== OURA_TOKEN_URL) throw new Error("unexpected");
      tokenCalls++;
      return new Response(
        JSON.stringify({
          access_token: "oura-access",
          refresh_token: "oura-refresh",
          expires_in: 86400,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const state = await mintOuraState();
    // Deny: Oura returns without a code. Nothing is exchanged or claimed.
    const denied = await ouraCallback(state, null);
    expect(denied.headers.get("location")).toContain(
      "oura=error&reason=nocode",
    );
    expect(tokenCalls).toBe(0);

    // Allow on the same authorize URL: same state, now with a code.
    const allowed = await ouraCallback(state, "allowed-code");
    expect(tokenCalls).toBe(1);
    expect(allowed.headers.get("location")).toContain("oura=connected");
  });
});

describe("Withings callback delivered twice", () => {
  it("exchanges the code once and sends the duplicate where the first went", async () => {
    const prisma = getPrismaClient();
    const session = await prisma.session.create({
      data: { userId: USER, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);

    let tokenCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url === WITHINGS_TOKEN_URL) {
        tokenCalls++;
        await new Promise((r) => setTimeout(r, PROVIDER_LATENCY_MS));
        return new Response(
          JSON.stringify({
            status: 0,
            body: {
              userid: "withings-single-use",
              access_token: "w-access",
              refresh_token: "w-refresh",
              expires_in: 3600,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === WITHINGS_NOTIFY_URL) {
        return new Response(JSON.stringify({ status: 0 }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const nonce = "single-use-nonce-22chr";
    await prisma.withingsOAuthState.create({
      data: {
        nonce,
        userId: USER,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    const { GET } = await import("@/app/api/withings/callback/route");
    const request = () =>
      new NextRequest(
        `http://localhost/api/withings/callback?code=w-code&state=${nonce}`,
        {
          method: "GET",
          headers: {
            cookie: `healthlog_session=${session.id}; withings_state=${nonce}`,
          },
        },
      );
    const [a, b] = await Promise.all([GET(request()), GET(request())]);

    expect(tokenCalls).toBe(1);
    expect(a.headers.get("location")).toContain("withings=connected");
    expect(b.headers.get("location")).toBe(a.headers.get("location"));
  });
});
