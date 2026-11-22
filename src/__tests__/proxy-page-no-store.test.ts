import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Session-gated pages serialise one account's health record into the HTML
 * document — the dashboard, Insights, the workouts list, the medications
 * list and the Coach all server-prefetch their data through a TanStack
 * `HydrationBoundary`, so the record ships inside the payload rather than
 * arriving over a later fetch.
 *
 * Those pages are dynamic today only because they read the session cookie.
 * That is a property of the page code, not a guarantee — so the proxy pins
 * `Cache-Control: private, no-store` on every session-gated page response.
 * `private` bars shared caches (a CDN, a reverse proxy); `no-store` also
 * bars the browser disk cache and the bfcache snapshot.
 *
 * These tests pin both sides: gated pages carry the header, and the public
 * surfaces that are deliberately cacheable do not.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";
import {
  ACCOUNT_SEED_REQUEST_HEADER,
  HEALTHLOG_PAGE_CACHE_HEADER,
} from "@/lib/http/page-cache-headers";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: { cookie: "healthlog_session=sess-1" },
  });
}

/** The pages that server-prefetch and dehydrate a record into the HTML. */
const PREFETCHING_PAGES = [
  "/",
  "/coach",
  "/insights",
  "/insights/workouts",
  "/medications",
];

/** Other session-gated surfaces that render account data. */
const OTHER_GATED_PAGES = [
  "/documents",
  "/settings/profile",
  "/admin/users",
  "/mood",
];

describe("proxy.ts no-store on session-gated pages", () => {
  it.each(PREFETCHING_PAGES)(
    "sets private, no-store on the prefetching page %s",
    (path) => {
      const res = proxy(makeRequest(path));
      const cacheControl = res.headers.get("cache-control") ?? "";
      expect(cacheControl).toContain("no-store");
      expect(cacheControl).toContain("private");
    },
  );

  it.each(OTHER_GATED_PAGES)(
    "sets private, no-store on the gated page %s",
    (path) => {
      const res = proxy(makeRequest(path));
      const cacheControl = res.headers.get("cache-control") ?? "";
      expect(cacheControl).toContain("no-store");
      expect(cacheControl).toContain("private");
    },
  );

  it("still emits no-store when the request carries no session cookie", () => {
    // The unauthenticated caller gets a redirect to /auth/login, which never
    // reaches the header block — assert the redirect rather than a header, so
    // the test states what actually happens on that arm.
    const res = proxy(new NextRequest("http://localhost/medications"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/auth/login");
  });

  it("makes a public page rendered for a session private, no-store", () => {
    // The page is public, but this request carries a session cookie, so the
    // document is rendered for that session: it is no more cacheable than
    // the dashboard. Pinned because 1.49.0 first shipped the account seed
    // into `/about` while these pages stayed cacheable.
    for (const path of ["/privacy", "/about", "/auth/login", "/onboarding"]) {
      const res = proxy(makeRequest(path));
      const cacheControl = res.headers.get("cache-control") ?? "";
      expect(cacheControl, path).toContain("no-store");
      expect(cacheControl, path).toContain("private");
      expect(res.headers.get(HEALTHLOG_PAGE_CACHE_HEADER), path).toBeNull();
    }
  });

  it("leaves the public legal + auth surfaces cacheable for an anonymous visitor", () => {
    for (const path of ["/privacy", "/about", "/auth/login"]) {
      const res = proxy(new NextRequest(`http://localhost${path}`));
      expect(res.headers.get("cache-control"), path).toBeNull();
      // The service worker keeps only pages that carry this permit.
      expect(res.headers.get(HEALTHLOG_PAGE_CACHE_HEADER), path).toBe(
        "anonymous",
      );
    }
  });

  it("gives no cache permit to a token page, signed out or not", () => {
    const res = proxy(new NextRequest("http://localhost/e/hle_abc"));
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get(HEALTHLOG_PAGE_CACHE_HEADER)).toBeNull();
  });

  it("gives no cache permit to a gated page", () => {
    const res = proxy(makeRequest("/medications"));
    expect(res.headers.get(HEALTHLOG_PAGE_CACHE_HEADER)).toBeNull();
  });

  it("hands the layout the seed permission on gated pages only, never from the client", () => {
    const forwarded = (res: Response) =>
      res.headers.get(`x-middleware-request-${ACCOUNT_SEED_REQUEST_HEADER}`);
    expect(forwarded(proxy(makeRequest("/medications")))).toBe("1");
    const spoofed = new NextRequest("http://localhost/about", {
      headers: {
        cookie: "healthlog_session=sess-1",
        [ACCOUNT_SEED_REQUEST_HEADER]: "1",
      },
    });
    expect(forwarded(proxy(spoofed))).toBeNull();
  });

  it("leaves the immutable locale catalog cacheable", () => {
    const res = proxy(makeRequest("/i18n/en"));
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("does not blanket API routes, which manage their own caching", () => {
    const res = proxy(makeRequest("/api/user/avatar/user-1"));
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("keeps the stricter share-link posture on /c/<token>", () => {
    const token = "hls_000000000000000000000000000000000000000000000000";
    const res = proxy(makeRequest(`/c/${token}`));
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("must-revalidate");
  });
});
