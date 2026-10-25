/**
 * Authorize endpoint — consent gate + audience + PKCE + redirect-URI binding.
 */
import { NextRequest } from "next/server";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.API_TOKEN_HMAC_KEY = "x".repeat(48);
process.env.APP_URL = "https://health.example";

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: (_n: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: vi.fn(async () => ({
    allowed: true,
    remaining: 59,
    resetAt: Date.now() + 60_000,
    ip: "1.2.3.4",
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
// The consent reads the session's own proof stamps. By default the session
// signed in a moment ago, which is a recent proof on an account without a
// second factor; the cases below age it.
vi.mock("@/lib/db", () => ({
  prisma: {
    session: {
      findUnique: vi.fn(async () => ({
        createdAt: new Date(),
        mfaVerifiedAt: null,
        reproofAt: null,
      })),
    },
    webauthnMfaCredential: { count: vi.fn(async () => 0) },
    passkey: { count: vi.fn(async () => 0) },
    // The password hash is read off the stored row; none here.
    user: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(async () => true),
}));

import { GET, POST } from "../authorize/route";
import { getSession } from "@/lib/auth/session";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { registerDcrClient } from "@/lib/mcp/oauth/clients";
import { s256Challenge } from "@/lib/mcp/oauth/pkce";
import { prisma } from "@/lib/db";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(64);
const CHALLENGE = s256Challenge(VERIFIER);
const RESOURCE = "https://health.example/mcp";

const CLIENT = registerDcrClient({
  clientName: "Claude",
  redirectUris: [REDIRECT],
});

function authorizeUrl(
  overrides: Record<string, string | undefined> = {},
): string {
  const params: Record<string, string | undefined> = {
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "health:read",
    state: "xyz",
    resource: RESOURCE,
    ...overrides,
  };
  const u = new URL("https://health.example/api/mcp/oauth/authorize");
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) u.searchParams.set(k, v);
  }
  return u.toString();
}

function getReq(url: string): Request {
  return new Request(url, { method: "GET" });
}

function postReq(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://health.example/api/mcp/oauth/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

function signedIn() {
  vi.mocked(getSession).mockResolvedValue({
    session: {
      id: "s1",
      expiresAt: new Date(Date.now() + 1e6),
      actingAsUserId: null,
      recordEpoch: 0,
    },
    user: { id: "user-1" } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(null);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
});

describe("GET /authorize — consent gate", () => {
  it("renders a consent screen for an authenticated user (no code issued)", async () => {
    signedIn();
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Authorize access/);
    expect(body).toMatch(/Claude/);
    expect(body).toMatch(/decision/); // the Allow/Deny form
    // A GET never mints a code.
    expect(body).not.toMatch(/hlac_/);
  });

  it("names what the connection can read, document text included", async () => {
    signedIn();
    const body = await (await GET(getReq(authorizeUrl()) as never)).text();
    // v1.39.3: search and fetch reach visits, conditions and the indexed
    // text of stored documents, so the consent says so before Allow.
    expect(body).toMatch(/visits/);
    expect(body).toMatch(/text of your stored documents/);
    expect(body).toMatch(/held back from AI reading/);
  });

  it("prompts sign-in (with a return link) when there is no session", async () => {
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/\/auth\/login/);
    expect(body).not.toMatch(/hlac_/);
  });
});

describe("GET /authorize — rejected requests", () => {
  it("rejects an audience mismatch with 400 invalid_target", async () => {
    signedIn();
    const res = await GET(
      getReq(authorizeUrl({ resource: "https://evil.example/mcp" })) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_target");
  });

  it("rejects a missing PKCE challenge with 400", async () => {
    signedIn();
    const res = await GET(
      getReq(
        authorizeUrl({
          code_challenge: undefined,
          code_challenge_method: undefined,
        }),
      ) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-S256 PKCE method with 400", async () => {
    signedIn();
    const res = await GET(
      getReq(authorizeUrl({ code_challenge_method: "plain" })) as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown client with 400 invalid_client", async () => {
    signedIn();
    const res = await GET(
      getReq(authorizeUrl({ client_id: "bogus" })) as never,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("rejects a redirect_uri not registered to the client", async () => {
    signedIn();
    const res = await GET(
      getReq(
        authorizeUrl({ redirect_uri: "https://evil.example/cb" }),
      ) as never,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /authorize — consent provenance (L1)", () => {
  it("labels a DCR client as unverified (self-asserted name)", async () => {
    signedIn();
    const res = await GET(getReq(authorizeUrl()) as never);
    const body = await res.text();
    expect(body).toMatch(/Unverified application/);
  });
});

describe("authorize — surface availability (M1/M4)", () => {
  it("GET returns 503 when the API is globally disabled", async () => {
    signedIn();
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(503);
  });

  it("POST returns 503 when the API is globally disabled", async () => {
    signedIn();
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(res.status).toBe(503);
  });
});

describe("POST /authorize — cross-origin guard (L3)", () => {
  it("rejects a cross-origin Origin with 403", async () => {
    signedIn();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "health:read",
      resource: RESOURCE,
      decision: "allow",
    });
    const req = new Request("https://health.example/api/mcp/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: body.toString(),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(403);
  });

  it("rejects a cross-site Sec-Fetch-Site with 403", async () => {
    signedIn();
    const body = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT.clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "health:read",
      resource: RESOURCE,
      decision: "allow",
    });
    const req = new Request("https://health.example/api/mcp/oauth/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: body.toString(),
    });
    const res = await POST(req as never);
    expect(res.status).toBe(403);
  });
});

describe("POST /authorize — decision", () => {
  it("requires a session (401 when unauthenticated)", async () => {
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(res.status).toBe(401);
  });

  it("mints a code and 303s back on allow (a form POST is followed with GET)", async () => {
    signedIn();
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        state: "xyz",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const code = new URL(loc).searchParams.get("code");
    expect(code).toMatch(/^hlac_/);
    expect(new URL(loc).searchParams.get("state")).toBe("xyz");
    // RFC 9207 — the issuer identifier is echoed on the success redirect.
    expect(new URL(loc).searchParams.get("iss")).toBe("https://health.example");
  });

  it("303s with access_denied on deny", async () => {
    signedIn();
    const res = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "deny",
      }) as never,
    );
    expect(res.status).toBe(303);
    const loc = res.headers.get("location") ?? "";
    expect(new URL(loc).searchParams.get("error")).toBe("access_denied");
    // RFC 9207 — the issuer is echoed on the error redirect too.
    expect(new URL(loc).searchParams.get("iss")).toBe("https://health.example");
  });
});

describe("authorize — allowing a connection needs a recent proof", () => {
  // A queued stale stamp a case did not read must not leak into the next one.
  afterEach(() => {
    vi.mocked(prisma.session.findUnique).mockReset();
  });

  function staleSession() {
    vi.mocked(prisma.session.findUnique).mockResolvedValueOnce({
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      mfaVerifiedAt: null,
      reproofAt: null,
    } as never);
  }
  const allow = {
    response_type: "code",
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "health:read",
    state: "xyz",
    resource: RESOURCE,
    decision: "allow",
  };

  it("GET shows a confirm link instead of the form when the session is an hour old", async () => {
    signedIn();
    staleSession();
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Confirm it is you/);
    expect(body).not.toMatch(/name="decision"/);
    const href = body.match(/href="([^"]+)"/)?.[1] ?? "";
    const next =
      new URL(href.replace(/&amp;/g, "&"), "https://x").searchParams.get(
        "next",
      ) ?? "";
    expect(href.startsWith("/confirm-access?next=")).toBe(true);
    // Back to this exact consent request.
    expect(next).toBe(
      new URL(authorizeUrl()).pathname + new URL(authorizeUrl()).search,
    );
  });

  it("POST allow on an hour-old session mints nothing", async () => {
    signedIn();
    staleSession();
    const res = await POST(postReq(allow) as never);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toMatch(/confirm-access\?next=/);
  });

  it("an account with a second factor needs the factor, not a young session", async () => {
    vi.mocked(getSession).mockResolvedValue({
      session: {
        id: "s1",
        expiresAt: new Date(Date.now() + 1e6),
        actingAsUserId: null,
        recordEpoch: 0,
      },
      user: { id: "user-1", totpConfirmedAt: new Date("2026-01-01") } as never,
    });
    const res = await POST(postReq(allow) as never);
    expect(res.status).toBe(401);
  });

  it("deny needs no proof", async () => {
    signedIn();
    staleSession();
    const res = await POST(postReq({ ...allow, decision: "deny" }) as never);
    expect(res.status).toBe(303);
  });
});

describe("authorize CSP — the consent form may lead only to the validated redirect", () => {
  function csp(res: Response): string {
    return res.headers.get("content-security-policy") ?? "";
  }

  it("allows the registered client's redirect origin on the consent page", async () => {
    signedIn();
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    expect(csp(res)).toContain("form-action 'self' https://claude.ai;");
    expect(csp(res)).toContain("default-src 'none'");
    expect(csp(res)).toContain("frame-ancestors 'none'");
  });

  it("uses the requested loopback port the client is allowed to vary", async () => {
    const loopback = registerDcrClient({
      clientName: "Desktop client",
      redirectUris: ["http://127.0.0.1:4000/callback"],
    });
    signedIn();
    const res = await GET(
      getReq(
        authorizeUrl({
          client_id: loopback.clientId,
          redirect_uri: "http://127.0.0.1:53682/callback",
        }),
      ) as never,
    );
    expect(res.status).toBe(200);
    expect(csp(res)).toContain("form-action 'self' http://127.0.0.1:53682;");
  });

  it("never names a redirect origin that failed validation", async () => {
    signedIn();
    const res = await GET(
      getReq(
        authorizeUrl({ redirect_uri: "https://evil.example/cb" }),
      ) as never,
    );
    expect(res.status).toBe(400);
    expect(csp(res)).toContain("form-action 'self';");
    expect(csp(res)).not.toContain("evil.example");
  });

  it("keeps form-action to 'self' on the sign-in prompt", async () => {
    const res = await GET(getReq(authorizeUrl()) as never);
    expect(res.status).toBe(200);
    expect(csp(res)).toContain("form-action 'self';");
    expect(csp(res)).not.toContain("claude.ai");
  });

  it("sets the policy on the decision redirect and on refusals", async () => {
    signedIn();
    const allow = await POST(
      postReq({
        response_type: "code",
        client_id: CLIENT.clientId,
        redirect_uri: REDIRECT,
        code_challenge: CHALLENGE,
        code_challenge_method: "S256",
        scope: "health:read",
        resource: RESOURCE,
        decision: "allow",
      }) as never,
    );
    expect(allow.status).toBe(303);
    expect(csp(allow)).toContain("form-action 'self';");

    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const unavailable = await GET(getReq(authorizeUrl()) as never);
    expect(unavailable.status).toBe(503);
    expect(csp(unavailable)).toContain("default-src 'none'");
  });
});

/**
 * Dynamic registration lets anyone register "Claude" with a callback on a
 * host of their own and send a signed-in person the authorize link. The
 * consent page used to show the borrowed name and "Unverified application",
 * never where the code would go.
 */
describe("GET /authorize — where the access goes (M3)", () => {
  it("names the redirect host for a self-registered client, on the page and on Allow", async () => {
    const phish = registerDcrClient({
      clientName: "Claude",
      redirectUris: ["https://collector.example.net/cb"],
    });
    signedIn();
    const body = await (
      await GET(
        new NextRequest(
          authorizeUrl({
            client_id: phish.clientId,
            redirect_uri: "https://collector.example.net/cb",
          }),
        ),
      )
    ).text();
    expect(body).toMatch(/Check where this access goes/);
    expect(body).toMatch(
      /Access goes to:<\/strong> <code>collector\.example\.net<\/code>/,
    );
    expect(body).toMatch(
      /value="allow">Allow access for collector\.example\.net</,
    );
    // The warning comes before the borrowed name.
    expect(body.indexOf("Check where")).toBeLessThan(body.indexOf("Claude"));
  });

  it("says a loopback redirect stays on this device", async () => {
    const desktop = registerDcrClient({
      clientName: "Desktop client",
      redirectUris: ["http://127.0.0.1:4000/callback"],
    });
    signedIn();
    const body = await (
      await GET(
        new NextRequest(
          authorizeUrl({
            client_id: desktop.clientId,
            redirect_uri: "http://127.0.0.1:4000/callback",
          }),
        ),
      )
    ).text();
    expect(body).toMatch(/an application running on this device/);
    expect(body).not.toMatch(/Check where this access goes/);
  });
});
