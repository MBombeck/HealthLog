/**
 * The edge sends a visitor without a session to the sign-in page with the
 * page they asked for in `next`, so a home-screen shortcut or a notification
 * tap still arrives there after signing in. The sign-in page re-checks the
 * value (`sanitizeSameOriginPath`); the proxy only ever puts in the
 * request's own path and query.
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";

function signInRedirect(pathAndQuery: string): URL {
  const res = proxy(new NextRequest(`http://localhost${pathAndQuery}`));
  expect([307, 308]).toContain(res.status);
  return new URL(res.headers.get("location")!, "http://localhost");
}

describe("proxy.ts sign-in redirect", () => {
  it.each([
    "/measurements?add=WEIGHT&source=shortcut",
    "/mood?add=1",
    "/medications",
    "/?source=pwa",
  ])("carries %s to the sign-in page", (target) => {
    const location = signInRedirect(target);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("next")).toBe(target);
  });

  it("sends the bare start page to a bare sign-in page", () => {
    const location = signInRedirect("/");
    expect(location.pathname).toBe("/auth/login");
    expect(location.search).toBe("");
  });
});
