/**
 * Remote MCP endpoint (`/mcp`) — transport + gate tests.
 *
 * Drives the route handler with Web-standard `Request`s and asserts the
 * four front gates plus the read-only / admin-unreachable posture over the
 * HTTP wire:
 *
 *   - serves the tool list with a valid token (module on, under budget);
 *   - rejects a missing / malformed / rejected (revoked / expired / unknown)
 *     token with one blunt 401;
 *   - hides the surface (404) when the off-by-default `mcp` module is off;
 *   - trips 429 when the per-credential rate limit is exhausted;
 *   - never consults a cookie session, so the cookie-only `requireAdmin()`
 *     boundary is unreachable here regardless of token scope — a `["*"]`
 *     wildcard token still sees only the read tools (ADR-003 / ADR-005).
 *
 * The Bearer validator, module gate, and rate limiter are mocked so the
 * test exercises the route's own wiring without a DB; the structural
 * cookie-only admin boundary itself is pinned by the sibling
 * `src/lib/mcp/__tests__/admin-boundary.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMcpServerSpy, executeCoachTool } = vi.hoisted(() => ({
  createMcpServerSpy: vi.fn(),
  executeCoachTool: vi.fn(async () => ({ present: false, reason: "no_data" })),
}));

// The surface fails closed without a pinned origin (M1); pin it for the suite.
process.env.APP_URL = "http://localhost";

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/auth/bearer", () => ({
  resolveBearerToken: vi.fn(),
  BearerAuthError: class BearerAuthError extends Error {},
}));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkMcpRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn((r: { remaining: number; resetAt: number }) => ({
    "X-RateLimit-Remaining": String(r.remaining),
    "X-RateLimit-Reset": new Date(r.resetAt).toISOString(),
  })),
}));
// The factory pulls the Coach retrieval layer through `tools.ts`; stub the
// heavy executor + inventory so importing the route never reaches a DB. The
// list/reject paths never execute a tool, so the stubs are never called.
vi.mock("@/lib/ai/coach/tools/executor", () => ({ executeCoachTool }));
vi.mock("@/lib/ai/coach/tools/inventory", () => ({
  buildCoachDataInventory: vi.fn(),
}));
vi.mock("@/lib/mcp/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/server")>();
  return {
    ...actual,
    createMcpServer: (...args: Parameters<typeof actual.createMcpServer>) => {
      createMcpServerSpy(...args);
      return actual.createMcpServer(...args);
    },
  };
});
// A cookie path must NEVER be reached from the MCP wire. Mock both cookie
// sources so the test can assert they are never consulted.
const getSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getSession }));
const cookiesGet = vi.fn(() => undefined);
const headersGet = vi.fn(() => null);
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: cookiesGet,
    set: () => {},
    delete: () => {},
  })),
  headers: vi.fn(async () => ({ get: headersGet })),
}));

import { POST, GET } from "../route";
import { resolveBearerToken } from "@/lib/auth/bearer";
import { isModuleEnabled } from "@/lib/modules/gate";
import { checkMcpRateLimit } from "@/lib/rate-limit";
import { isApiGloballyEnabled } from "@/lib/app-settings";

const READ_TOOLS = [
  "get_correlations",
  "get_labs",
  "get_medication_compliance",
  "get_metric_series",
  "list_metrics",
  "search",
  "fetch",
  // Phase 4 — deep-value reads.
  "get_correlation",
  "compare_metric",
  "get_metric_baseline",
  "detect_changepoints",
  // v1.24 — Coach-F1 reads bridged to the wire.
  "get_glucose_panel",
  "get_sleep",
  "get_workouts",
  "get_illness_recovery",
  "get_cycle",
  // v1.24 — multi-metric fan-out.
  "get_metrics",
  // v1.24 — operational reads.
  "get_medication_schedule",
  "get_integration_status",
  "get_preventive_care",
  // v1.30 coverage review — nutrients, intraday pulse, ECG metadata.
  "get_nutrients",
  "get_intraday_pulse",
  "get_ecg_recordings",
  // v1.38 — the bounded visit history.
  "get_visits",
].sort();

/** A valid, narrow-scope (`health:read`) token resolution. */
function validToken(permissions: string[] = ["health:read"]) {
  vi.mocked(resolveBearerToken).mockResolvedValue({
    user: { id: "user-1" } as never,
    tokenId: "token-1",
    permissions,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

function postRpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer hlk_" + "a".repeat(64),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const GET_LABS = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "get_labs", arguments: {} },
};

beforeEach(() => {
  vi.clearAllMocks();
  cookiesGet.mockReturnValue(undefined);
  headersGet.mockReturnValue(null);
  // Default happy-path: module on, under budget.
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(checkMcpRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 119,
    resetAt: Date.now() + 60_000,
  });
  executeCoachTool.mockResolvedValue({ present: false, reason: "no_data" });
});

describe("/mcp — happy path", () => {
  it("serves the read-tool list over HTTP with a valid token", async () => {
    validToken();
    const res = await POST(postRpc(TOOLS_LIST));

    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.result.tools as Array<{ name: string }>)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(READ_TOOLS);

    // The gate ran in the documented order: auth → rate-limit → module.
    expect(resolveBearerToken).toHaveBeenCalledTimes(1);
    expect(checkMcpRateLimit).toHaveBeenCalledWith("user-1:token-1");
    expect(isModuleEnabled).toHaveBeenCalledWith("user-1", "mcp");
  });

  it("completes the initialize handshake with the HealthLog server identity", async () => {
    validToken();
    const res = await POST(
      postRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe("healthlog");
    // Tools + resources are advertised; no admin capability exists.
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it.each([
    ["health:read", ["health:read"]],
    ["wildcard", ["*"]],
  ])("lets a %s token reach a real health reader", async (_label, scopes) => {
    validToken(scopes);

    const res = await POST(postRpc(GET_LABS));

    expect(res.status).toBe(200);
    expect(executeCoachTool).toHaveBeenCalledWith({
      userId: "user-1",
      name: "get_labs",
      rawArguments: "{}",
    });
  });
});

describe("/mcp — Origin gate (DNS-rebinding defense, spec PR #1439)", () => {
  it("rejects a cross-origin browser request with 403 before auth", async () => {
    validToken();
    const res = await POST(
      postRpc(TOOLS_LIST, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
    // The Origin check runs first — the token table is never consulted.
    expect(resolveBearerToken).not.toHaveBeenCalled();
  });

  it("allows a same-origin request", async () => {
    validToken();
    const res = await POST(postRpc(TOOLS_LIST, { origin: "http://localhost" }));
    expect(res.status).toBe(200);
  });

  it("allows a request with no Origin header (non-browser MCP client)", async () => {
    validToken();
    const res = await POST(postRpc(TOOLS_LIST));
    expect(res.status).toBe(200);
  });
});

describe("/mcp — operator kill-switch (M4)", () => {
  it("hides the surface (404) when the API is globally disabled", async () => {
    validToken();
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(false);
    const res = await POST(postRpc(TOOLS_LIST));
    expect(res.status).toBe(404);
    // Fails closed before the token table is consulted.
    expect(resolveBearerToken).not.toHaveBeenCalled();
  });
});

describe("/mcp — 401 carries the RFC 9728 resource_metadata pointer", () => {
  it("includes resource_metadata in the WWW-Authenticate challenge", async () => {
    const res = await POST(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(TOOLS_LIST),
      }),
    );
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/Bearer/);
    expect(challenge).toMatch(
      /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/,
    );
  });
});

describe("/mcp — authentication", () => {
  it("rejects a request with no Authorization header (401 + challenge)", async () => {
    const res = await POST(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(TOOLS_LIST),
      }),
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    // The token table is never consulted when no token is presented.
    expect(resolveBearerToken).not.toHaveBeenCalled();
    // No module read, no rate-limit hit before auth fails.
    expect(isModuleEnabled).not.toHaveBeenCalled();
    expect(checkMcpRateLimit).not.toHaveBeenCalled();
  });

  it("rejects a malformed Authorization header (not Bearer) with 401", async () => {
    const res = await POST(
      postRpc(TOOLS_LIST, { authorization: "Basic abc123" }),
    );
    expect(res.status).toBe(401);
    expect(resolveBearerToken).not.toHaveBeenCalled();
  });

  it("rejects a revoked / expired / unknown token with a blunt 401", async () => {
    vi.mocked(resolveBearerToken).mockRejectedValue(new Error("revoked"));
    const res = await POST(postRpc(TOOLS_LIST));

    expect(res.status).toBe(401);
    const body = await res.json();
    // No oracle: the body never echoes the rejection reason or the token.
    expect(JSON.stringify(body)).not.toMatch(/revoked|expired|hlk_/);
    // A rejected token never reaches the module gate or the transport.
    expect(isModuleEnabled).not.toHaveBeenCalled();
    expect(createMcpServerSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["medication ingest", ["medication:ingest"]],
    ["notifications", ["notifications:send"]],
    ["FHIR", ["fhir:read"]],
    ["write-only", ["health:write"]],
    ["unrelated", ["profile:read"]],
  ])(
    "denies a valid %s token before server registration or health reads",
    async (_label, scopes) => {
      validToken(scopes);

      const res = await POST(postRpc(GET_LABS));

      expect([401, 403]).toContain(res.status);
      expect(createMcpServerSpy).not.toHaveBeenCalled();
      expect(executeCoachTool).not.toHaveBeenCalled();
      expect(checkMcpRateLimit).not.toHaveBeenCalled();
      expect(isModuleEnabled).not.toHaveBeenCalled();
    },
  );
});

describe("/mcp — module gate (off by default)", () => {
  it("hides the surface with 404 when the mcp module is off", async () => {
    validToken();
    vi.mocked(isModuleEnabled).mockResolvedValue(false);

    const res = await POST(postRpc(TOOLS_LIST));
    expect(res.status).toBe(404);
    // Authenticated first (so the module is resolved per-user), then hidden.
    expect(resolveBearerToken).toHaveBeenCalledTimes(1);
    expect(isModuleEnabled).toHaveBeenCalledWith("user-1", "mcp");
  });
});

describe("/mcp — rate limit", () => {
  it("trips 429 once the per-credential budget is exhausted", async () => {
    validToken();
    vi.mocked(checkMcpRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    });

    const res = await POST(postRpc(TOOLS_LIST));
    expect(res.status).toBe(429);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    // The limiter is keyed by the `<userId>:<tokenId>` binding.
    expect(checkMcpRateLimit).toHaveBeenCalledWith("user-1:token-1");
    // A throttled request never reaches the module gate or the transport.
    expect(isModuleEnabled).not.toHaveBeenCalled();
  });
});

describe("/mcp — admin unreachable over HTTP (cookie-only boundary)", () => {
  it("never consults a cookie session, even with a wildcard token", async () => {
    validToken(["*"]);
    const res = await POST(postRpc(TOOLS_LIST));

    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );

    // A `["*"]` token carries write capability (`tokenAllowsWrite`), so it
    // sees the confirmed write tools alongside the read tools — but NO admin
    // tool exists, and admin stays unreachable here by construction.
    for (const read of READ_TOOLS) {
      expect(names).toContain(read);
    }
    expect(names).toContain("log_measurement");
    expect(names).toContain("log_mood");
    for (const name of names) {
      expect(name).not.toMatch(/admin/i);
    }

    // The route authenticates purely by Bearer: a cookie session is never
    // read, so `requireAdmin()` (cookie-only) can never be reached here.
    expect(getSession).not.toHaveBeenCalled();
    expect(cookiesGet).not.toHaveBeenCalled();
  });
});

describe("/mcp — write tools gate on health:write", () => {
  it("a health:read token lists NO write tools", async () => {
    validToken(["health:read"]);
    const res = await POST(postRpc(TOOLS_LIST));
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(names.sort()).toEqual(READ_TOOLS);
    expect(names).not.toContain("log_measurement");
    expect(names).not.toContain("log_mood");
  });

  it("a health:read+write token can list (and thus invoke) the write tools", async () => {
    validToken(["health:read", "health:write"]);
    const res = await POST(postRpc(TOOLS_LIST));
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = (body.result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(names).toContain("log_measurement");
    expect(names).toContain("log_mood");
    expect(names).toContain("log_blood_pressure");
  });
});

describe("/mcp — GET transport", () => {
  it("is wired for GET (SSE stream open) behind the same gates", async () => {
    validToken();
    const res = await GET(
      new Request("http://localhost/mcp", {
        method: "GET",
        headers: {
          authorization: "Bearer hlk_" + "a".repeat(64),
          accept: "text/event-stream",
        },
      }),
    );
    // Auth + gates ran; the transport answers (a stream open or a
    // method-specific status), never a 401/404/429 on the happy path.
    expect([200, 405]).toContain(res.status);
    expect(resolveBearerToken).toHaveBeenCalledTimes(1);
    expect(isModuleEnabled).toHaveBeenCalledWith("user-1", "mcp");
    // Release any opened stream so the test process can exit cleanly.
    await res.body?.cancel().catch(() => {});
  });
});
