import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.17.0 — `/invite/<hlv_token>` is the invite universal-link landing
 * (iOS #16). It is a thin shape-validated redirect onto
 * `/auth/register?invite=…` and carries no session, so an unauthenticated
 * visitor (scanning the admin QR) must reach it without the auth-gate
 * bounce to `/auth/login`. This guard locks the allowlist entry in place
 * so a future refactor of `src/proxy.ts` cannot silently re-gate it.
 *
 * v1.38.19 — the redirect moved here, to the edge. It used to be emitted by
 * `src/app/invite/[token]/page.tsx`, and Next does not answer that with a
 * server 307: it streams the root layout first and puts the redirect in the
 * flight payload, so `<AuthShell>` mounted on `/invite/…`, read the pathname
 * as a protected route and raced its own `router.replace("/auth/login")`
 * against the redirect. Answering at the edge means there is no HTML, no
 * hydration and no race — the behaviour the page's doc comment already
 * claimed. The page stays as the fallback for any path that bypasses the
 * proxy matcher.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

const VALID_TOKEN = `hlv_${"a".repeat(64)}`;

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

describe("proxy.ts /invite public-allowlist (v1.17.0)", () => {
  it("does not 307 an unauthenticated /invite/<token> to /auth/login", () => {
    const res = proxy(makeRequest(`/invite/${VALID_TOKEN}`));
    expect(res.headers.get("location") ?? "").not.toMatch(/\/auth\/login/);
  });

  it("does not bounce a pending-onboarding session off the invite landing", () => {
    const res = proxy(
      makeRequest(`/invite/${VALID_TOKEN}`, {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect(res.headers.get("location") ?? "").not.toMatch(/\/onboarding/);
    expect(res.headers.get("location") ?? "").not.toMatch(/\/auth\/login/);
  });

  it("hardens the token-in-path surface against cache / index / referrer leaks", () => {
    // Mirror the `/c/<token>` edge defence — the secret rides in the path,
    // so no CDN may cache it and no crawler may index the URL.
    const res = proxy(makeRequest(`/invite/${VALID_TOKEN}`));
    expect(res.headers.get("Cache-Control")).toBe(
      "no-store, no-cache, must-revalidate",
    );
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("still redirects unauthenticated requests for protected pages", () => {
    // Negative check — confirms the fixture would catch a real
    // regression. `/insights` is not public.
    const res = proxy(makeRequest("/insights"));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/auth\/login/);
  });
});

describe("proxy.ts /invite edge redirect (v1.38.19)", () => {
  it("307s a shape-valid token straight onto the registration form", () => {
    const res = proxy(makeRequest(`/invite/${VALID_TOKEN}`));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      `http://localhost/auth/register?invite=${VALID_TOKEN}`,
    );
  });

  it("307s a malformed segment onto a bare registration form", () => {
    // Never echo an attacker-controlled segment into the target — a
    // malformed token behaves exactly like a visitor with no invite.
    const res = proxy(makeRequest("/invite/not-a-token"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/auth/register");
  });

  it("ignores anything after the token segment", () => {
    const res = proxy(makeRequest(`/invite/${VALID_TOKEN}/extra`));
    expect(res.headers.get("location")).toBe(
      `http://localhost/auth/register?invite=${VALID_TOKEN}`,
    );
  });

  it.each([
    ["an uppercase hex body", `hlv_${"A".repeat(64)}`],
    ["a short body", `hlv_${"a".repeat(63)}`],
    ["a long body", `hlv_${"a".repeat(65)}`],
    ["the wrong prefix", `hlk_${"a".repeat(64)}`],
    ["an empty segment", ""],
  ])("drops %s rather than echoing it into the target", (_label, segment) => {
    const res = proxy(makeRequest(`/invite/${segment}`));
    expect(res.headers.get("location")).toBe("http://localhost/auth/register");
  });

  it("keeps the token hardening on the malformed redirect too", () => {
    const res = proxy(makeRequest("/invite/not-a-token"));
    expect(res.headers.get("Cache-Control")).toBe(
      "no-store, no-cache, must-revalidate",
    );
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("carries the baseline transport headers on the redirect hop", () => {
    const res = proxy(makeRequest(`/invite/${VALID_TOKEN}`));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("redirects a signed-in caller the same way, with no session read", () => {
    const res = proxy(
      makeRequest(`/invite/${VALID_TOKEN}`, { healthlog_session: "sess-1" }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      `http://localhost/auth/register?invite=${VALID_TOKEN}`,
    );
  });
});
