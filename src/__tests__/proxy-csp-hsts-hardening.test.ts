import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * F-5 (mobile security audit, 2026-05-16): two security headers
 * needed to harden against first-visit MITM and to scope the
 * Withings backend host to its surface only.
 *
 *   - HSTS now carries `; preload` so `healthlog.bombeck.io` is
 *     eligible for the Chromium HSTS preload list.
 *   - The `wbsapi.withings.net` `connect-src` entry only ships on
 *     the Withings surfaces (`/settings/integrations/withings/*`
 *     and `/api/withings/*`) instead of globally — same gating
 *     pattern the AI hosts already use.
 *
 * Both checks lock the proxy in place so a future refactor cannot
 * silently regress either one.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

// `NODE_ENV` is a special read-only property on node's `process.env`
// proxy. `vi.stubEnv` knows how to patch it without tripping the
// "only accepts a configurable, writable, and enumerable data
// descriptor" guard that a direct `defineProperty` runs into.
function setNodeEnv(value: "development" | "production") {
  vi.stubEnv("NODE_ENV", value);
}

beforeEach(() => {
  // Default to production so the production-only headers run; individual
  // tests can flip back to development if they care about the dev shape.
  setNodeEnv("production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(
  pathname: string,
  cookies: Record<string, string> = {},
): NextRequest {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://localhost${pathname}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
}

describe("proxy.ts HSTS preload (F-5, 2026-05-16)", () => {
  it("attaches `preload` to the Strict-Transport-Security header in production", () => {
    const res = proxy(makeRequest("/", { healthlog_session: "sess-1" }));
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains; preload",
    );
  });

  it("does not ship HSTS in development", () => {
    setNodeEnv("development");
    const res = proxy(makeRequest("/", { healthlog_session: "sess-1" }));
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("proxy.ts Withings CSP gating (F-5, 2026-05-16)", () => {
  it("does NOT allow wbsapi.withings.net on a non-Withings page", () => {
    const res = proxy(makeRequest("/", { healthlog_session: "sess-1" }));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/wbsapi\.withings\.net/);
  });

  it("allows wbsapi.withings.net under /settings/integrations/withings/*", () => {
    const res = proxy(
      makeRequest("/settings/integrations/withings", {
        healthlog_session: "sess-1",
      }),
    );
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/connect-src[^;]*https:\/\/wbsapi\.withings\.net/);
  });

  it("allows wbsapi.withings.net under /api/withings/*", () => {
    const res = proxy(
      makeRequest("/api/withings/callback", {
        healthlog_session: "sess-1",
      }),
    );
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/connect-src[^;]*https:\/\/wbsapi\.withings\.net/);
  });

  it("never ships the Withings host on the auth surface (DOM-XSS exfil channel)", () => {
    const res = proxy(makeRequest("/auth/login"));
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toMatch(/wbsapi\.withings\.net/);
  });
});
