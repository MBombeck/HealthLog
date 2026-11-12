/**
 * Security headers on the proxy's EARLY EXITS.
 *
 * The full header block sits at the bottom of `proxy()`, after the pass-through
 * `NextResponse.next()`. Seven exits return before it — the worker-only 503,
 * two legacy 301s, the demo-mode 403, and the login / onboarding / MFA
 * redirects — and used to carry no HSTS, no framing refusal and no nosniff at
 * all.
 *
 * The exposure was one hop (a redirect has no rendered body, and the follow-up
 * navigation re-enters the proxy and does get the full set), but HSTS is worth
 * the most on exactly that first hop over a hostile network. These assertions
 * exist so a future exit added above the header block cannot silently rejoin
 * the unprotected set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const shouldRunWeb = vi.fn(() => true);

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => shouldRunWeb(),
}));

import { proxy } from "../proxy";
import { applyBypassRouteHeaders } from "@/lib/http/proxy-bypass-routes";

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

const ORIGINAL_DEMO = process.env.DEMO_MODE;

beforeEach(() => {
  shouldRunWeb.mockReturnValue(true);
  vi.stubEnv("NODE_ENV", "production");
  delete process.env.DEMO_MODE;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_DEMO === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO;
});

/** The transport subset every exit must carry. */
function expectBaselineHeaders(res: Response) {
  expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("Referrer-Policy")).toBe(
    "strict-origin-when-cross-origin",
  );
  expect(res.headers.get("Permissions-Policy")).toContain("camera=()");
  expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe(
    "credentialless",
  );
  expect(res.headers.get("X-Permitted-Cross-Domain-Policies")).toBe("none");
  expect(res.headers.get("Strict-Transport-Security")).toContain(
    "max-age=31536000",
  );
}

describe("proxy early exits carry the baseline security headers", () => {
  it("worker-only 503", () => {
    shouldRunWeb.mockReturnValue(false);
    const res = proxy(makeRequest("/dashboard"));
    expect(res.status).toBe(503);
    expectBaselineHeaders(res);
  });

  it("legacy 301 redirect", () => {
    const res = proxy(makeRequest("/stimmung"));
    expect(res.status).toBe(301);
    expectBaselineHeaders(res);
  });

  it("unauthenticated page redirect to /auth/login", () => {
    const res = proxy(makeRequest("/dashboard"));
    expect(res.headers.get("location")).toMatch(/\/auth\/login(\?|$)/);
    expectBaselineHeaders(res);
  });

  it("onboarding redirect", () => {
    const res = proxy(
      makeRequest("/", {
        cookies: { healthlog_session: "sess-1", hl_onboarding: "pending" },
      }),
    );
    expect(res.headers.get("location")).toMatch(/\/onboarding$/);
    expectBaselineHeaders(res);
  });

  it("demo-mode 403 on a blocked mutation", () => {
    process.env.DEMO_MODE = "true";
    const res = proxy(
      makeRequest("/api/measurements", {
        method: "POST",
        cookies: { healthlog_session: "sess-1" },
      }),
    );
    expect(res.status).toBe(403);
    expectBaselineHeaders(res);
  });

  it("omits HSTS in development, like the main header block", () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = proxy(makeRequest("/stimmung"));
    expect(res.status).toBe(301);
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    // The non-transport-dependent headers still attach.
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("the routes that bypass the proxy", () => {
  it("carry the same cross-origin headers the proxy sets on a full response", () => {
    const viaProxy = proxy(makeRequest("/api/health"));
    const headers = new Headers();
    applyBypassRouteHeaders(headers);
    for (const name of [
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
      "Cross-Origin-Embedder-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "X-Permitted-Cross-Domain-Policies",
      "Strict-Transport-Security",
    ]) {
      expect(headers.get(name), name).toBe(viaProxy.headers.get(name));
    }
  });
});
