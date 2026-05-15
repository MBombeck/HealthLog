import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.26 — `/privacy` is a public legal page. Apple's App Store
 * Connect submission process requires the privacy-policy URL to be
 * reachable without authentication. This guard locks the proxy
 * allowlist in place so a future refactor of `src/proxy.ts` can't
 * silently re-gate the page behind a session cookie.
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

describe("proxy.ts /privacy public-allowlist (v1.4.26)", () => {
  it("does not 307 unauthenticated requests for /privacy to /auth/login", () => {
    const res = proxy(makeRequest("/privacy"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not 307 a pending-onboarding session away from /privacy", () => {
    // A user whose onboarding has not completed must still be able to
    // reach the legal page — GDPR Art. 13 expects pre-signup visibility,
    // and any redirect would be a worse user experience for an App
    // Store reviewer following the registered policy URL.
    const res = proxy(
      makeRequest("/privacy", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
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
