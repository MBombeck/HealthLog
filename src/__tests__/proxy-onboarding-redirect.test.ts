import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.4.22 C4 — onboarding redirect moved from `<AuthShell>` useEffect
 * to `src/proxy.ts` so it lands on the first server response instead
 * of post-hydration. The previous client-side approach caused a brief
 * dashboard flash for users with `onboardingCompletedAt === null`.
 *
 * The proxy reads the `hl_onboarding` cookie (which the auth routes
 * mirror from the DB `onboardingCompletedAt` column) without a DB
 * roundtrip — Edge runtime can't reach Prisma. The cookie is a UX
 * hint, not a security signal: a user editing it locally only skips
 * the dashboard flash, they still can't bypass any server check.
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

describe("proxy.ts onboarding redirect (v1.4.22 C4)", () => {
  it("307s a session with hl_onboarding=pending from / to /onboarding", () => {
    const res = proxy(
      makeRequest("/", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    // NextResponse.redirect returns a 307 by default in Next 16.
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/onboarding$/);
  });

  it("307s a pending session from /insights to /onboarding", () => {
    const res = proxy(
      makeRequest("/insights", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/onboarding$/);
  });

  it("does NOT redirect from /onboarding itself", () => {
    const res = proxy(
      makeRequest("/onboarding", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    // /onboarding is in PUBLIC_PATHS so the proxy passes through; the
    // response is a NextResponse.next() with security headers applied.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does NOT redirect from /auth/login", () => {
    const res = proxy(makeRequest("/auth/login", { hl_onboarding: "pending" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes through when hl_onboarding cookie is absent (completed users)", () => {
    const res = proxy(makeRequest("/", { healthlog_session: "sess-1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes through API routes even when onboarding is pending", () => {
    // API routes do their own getSession() checks — the proxy must
    // never redirect them or every legitimate /api/* call would 307.
    const res = proxy(
      makeRequest("/api/measurements", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still redirects unauthenticated users to /auth/login (existing contract)", () => {
    const res = proxy(makeRequest("/"));
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/auth\/login$/);
  });

  /**
   * v1.4.22 W5 reconcile (Sec-MED-2) — exact-match `/onboarding`
   * plus subroutes. A hypothetical `/onboarding-export` route must
   * NOT inherit the public-pass-through that the literal
   * `/onboarding` carries.
   */
  it("does NOT treat /onboarding-export as the onboarding surface (exact-match guard)", () => {
    const res = proxy(makeRequest("/onboarding-export"));
    // Unauthenticated request to a non-public route: redirects to
    // /auth/login. If the loose `startsWith("/onboarding")` matcher
    // were still in place it would short-circuit through public-path
    // handling and 200 instead.
    expect([307, 308]).toContain(res.status);
    expect(res.headers.get("location")).toMatch(/\/auth\/login$/);
  });

  it("still treats subroutes /onboarding/<x> as the onboarding surface", () => {
    const res = proxy(
      makeRequest("/onboarding/step-2", {
        healthlog_session: "sess-1",
        hl_onboarding: "pending",
      }),
    );
    // /onboarding/step-2 is part of the onboarding surface so the
    // pending redirect short-circuits.
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("generates CSP nonces without relying on Node Buffer", () => {
    const originalBuffer = (
      globalThis as typeof globalThis & { Buffer?: Buffer }
    ).Buffer;
    Object.defineProperty(globalThis, "Buffer", {
      value: undefined,
      configurable: true,
    });

    try {
      const res = proxy(makeRequest("/", { healthlog_session: "sess-1" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy")).toMatch(
        /nonce-'?[A-Za-z0-9+/]{22}==/,
      );
    } finally {
      Object.defineProperty(globalThis, "Buffer", {
        value: originalBuffer,
        configurable: true,
      });
    }
  });
});
