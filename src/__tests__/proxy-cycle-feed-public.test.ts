import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1350 — the cycle calendar feed at `/api/cycle/feed/<hlf_token>.ics`.
 *
 * A calendar provider polls it from its own servers with no cookie, so the
 * proxy must pass the request through untouched, keep it out of indexes and
 * referrers, and leave its caching to the route (`private, no-cache` plus an
 * ETag) rather than stamping `no-store` over the validator path. The
 * management routes beside it stay cookie-only and are not on the list.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { PUBLIC_PATHS, proxy } from "../proxy";

// Built at run time so no token-shaped literal sits in the source.
const TOKEN = `hlf_${"7d".repeat(24)}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy on /api/cycle/feed/<token>", () => {
  it("lists the feed prefix, trailing slash included, and not the management namespace", () => {
    expect(PUBLIC_PATHS).toContain("/api/cycle/feed/");
    expect(
      PUBLIC_PATHS.some((p) => "/api/cycle/feed-subscription".startsWith(p)),
    ).toBe(false);
  });

  it("passes a cookie-less GET through to the route", () => {
    const res = proxy(
      new NextRequest(`http://localhost/api/cycle/feed/${TOKEN}.ics`, {
        headers: { "user-agent": "Google-Calendar-Importer" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the token out of indexes and referrers", () => {
    const res = proxy(
      new NextRequest(`http://localhost/api/cycle/feed/${TOKEN}.ics`),
    );
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("leaves the route's Cache-Control alone, so the ETag path survives", () => {
    const res = proxy(
      new NextRequest(`http://localhost/api/cycle/feed/${TOKEN}.ics`),
    );
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("serves a cookie-less GET in demo mode too: a read, not a mutation", () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = proxy(
      new NextRequest(`http://localhost/api/cycle/feed/${TOKEN}.ics`),
    );
    expect(res.status).toBe(200);
  });

  it("refuses a demo-mode mint at the edge", () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = proxy(
      new NextRequest("http://localhost/api/cycle/feed-subscription", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });
});
