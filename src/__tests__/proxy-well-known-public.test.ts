import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.33 — `/.well-known/*` is a credential-free IETF discovery
 * namespace (RFC 8615). Apple in particular reads
 * `/.well-known/apple-app-site-association` without a session to wire
 * Web Credentials (passkey sharing) and Universal Links to the iOS
 * bundle. This guard locks the proxy allowlist in place so a future
 * refactor of `src/proxy.ts` can't silently re-gate the namespace
 * behind a session cookie and break the Apple CDN fetch.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

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

describe("proxy.ts /.well-known/* public-allowlist (v1.4.33)", () => {
  it("does not 307 unauthenticated requests for the AASA file", () => {
    const res = proxy(makeRequest("/.well-known/apple-app-site-association"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not 307 a pending-onboarding session away from the AASA file", () => {
    // Apple's CDN fetch carries no cookies, so this branch is mainly
    // a belt-and-braces check; the redirect would only fire for a
    // human visitor who happened to have a half-finished onboarding
    // session and typed the URL by hand. Either way the asset must
    // answer 200 with the JSON body unchanged.
    const res = proxy(
      makeRequest("/.well-known/apple-app-site-association", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("admits any other future /.well-known/* discovery file", () => {
    // The allowlist entry is a `/.well-known/` prefix so future
    // additions (e.g. `/.well-known/security.txt` or
    // `/.well-known/openid-configuration`) don't need a second proxy
    // edit. This check fails the moment the prefix is tightened to
    // a literal `/.well-known/apple-app-site-association` only.
    const res = proxy(makeRequest("/.well-known/security.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects unauthenticated requests for protected pages", () => {
    // Negative check — confirms the test fixture would catch a real
    // regression. `/insights` is not public; an unauthenticated visit
    // must still 307 to /auth/login.
    const res = proxy(makeRequest("/insights"));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/auth\/login/);
  });
});
