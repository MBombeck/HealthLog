import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.42 (#959) — `/claim/<hlp_token>` is the managed-profile handover link.
 *
 * The twin of `proxy-invite-public.test.ts`: the link is a shape-validated
 * edge redirect onto `/auth/claim?token=…`, it carries no session, and the
 * hop is uncacheable, unindexable and never leaked as a `Referer`. The two API
 * routes behind the page authenticate by the token in the request body, so
 * they pass the page gate; on a demo instance they are refused like every
 * other mutation off the allowlist.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy, PUBLIC_PATHS } from "../proxy";

const VALID_TOKEN = `hlp_${"a".repeat(64)}`;

function makeRequest(
  pathname: string,
  init: { cookies?: Record<string, string>; method?: string } = {},
): NextRequest {
  const cookieHeader = Object.entries(init.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://localhost${pathname}`, {
    method: init.method ?? "GET",
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

describe("proxy.ts /claim public allowlist", () => {
  it("lists the landing and the anonymous claim routes as public", () => {
    expect(PUBLIC_PATHS).toContain("/claim/");
    expect(PUBLIC_PATHS).toContain("/api/auth/claim");
  });

  it("does not bounce an unauthenticated /claim/<token> to /auth/login", () => {
    const res = proxy(makeRequest(`/claim/${VALID_TOKEN}`));
    expect(res.headers.get("location") ?? "").not.toMatch(/\/auth\/login/);
  });

  it("does not bounce a pending-onboarding session off the link", () => {
    const res = proxy(
      makeRequest(`/claim/${VALID_TOKEN}`, {
        cookies: { healthlog_session: "sess-1", hl_onboarding: "pending" },
      }),
    );
    expect(res.headers.get("location") ?? "").not.toMatch(/\/onboarding/);
  });

  it("lets the anonymous preview and claim reach their handlers", () => {
    for (const path of ["/api/auth/claim", "/api/auth/claim/preview"]) {
      const res = proxy(makeRequest(path, { method: "POST" }));
      expect(res.status, path).not.toBe(401);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });
});

describe("proxy.ts /claim edge redirect", () => {
  it("307s a shape-valid token onto the claim page", () => {
    const res = proxy(makeRequest(`/claim/${VALID_TOKEN}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      `http://localhost/auth/claim?token=${VALID_TOKEN}`,
    );
  });

  it.each([
    ["an uppercase hex body", `hlp_${"A".repeat(64)}`],
    ["a short body", `hlp_${"a".repeat(63)}`],
    ["a long body", `hlp_${"a".repeat(65)}`],
    ["an invite token", `hlv_${"a".repeat(64)}`],
    ["markup", "%3Cscript%3E"],
  ])("drops %s rather than echoing it into the target", (_label, segment) => {
    const res = proxy(makeRequest(`/claim/${segment}`));
    expect(res.headers.get("location")).toBe("http://localhost/auth/claim");
  });

  it("hardens the token-in-path hop against cache, index and referrer leaks", () => {
    const res = proxy(makeRequest(`/claim/${VALID_TOKEN}`));
    expect(res.headers.get("Cache-Control")).toBe(
      "no-store, no-cache, must-revalidate",
    );
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("proxy.ts DEMO_MODE refuses the handover", () => {
  const original = process.env.DEMO_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = original;
  });

  it.each([
    ["POST", "/api/auth/claim"],
    ["POST", "/api/auth/claim/preview"],
    ["POST", "/api/managed-profiles/p1/handover"],
    ["DELETE", "/api/managed-profiles/p1/handover"],
    ["POST", "/api/account/handover-decision"],
  ])("403s %s %s on a demo instance", async (method, path) => {
    process.env.DEMO_MODE = "true";
    const res = proxy(
      makeRequest(path, {
        method,
        cookies: { healthlog_session: "sess-1" },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("leaves the same claim alone off demo mode", () => {
    delete process.env.DEMO_MODE;
    const res = proxy(makeRequest("/api/auth/claim", { method: "POST" }));
    expect(res.status).not.toBe(403);
  });
});
