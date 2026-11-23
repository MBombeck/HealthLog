import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The share page's gate in the proxy, for a browser that takes no cookies.
 *
 * The entry route `/c/<token>` sets the gate cookie and sends the browser on
 * to `/c/<token>/view`; the proxy sends a visit without the cookie back. A
 * browser that refuses the cookie went round that circle until it gave up
 * with "too many redirects". The route's hop now carries when it was made, and
 * a cookie-less visit on a fresh hop goes back with `?cookies=off`, where the
 * route explains instead of redirecting again. A visit without the hop, or on
 * an old one, still goes back through the gate as before, and nothing here
 * ever lets the page itself render without the cookie.
 */

vi.mock("@/lib/process-type", () => ({
  shouldRunWeb: () => true,
}));

import { proxy } from "../proxy";
import {
  isFreshShareViewHop,
  SHARE_VIEW_GATE_COOKIE,
  SHARE_VIEW_HOP_WINDOW_MS,
} from "@/lib/clinician-share/view-gate";

const TOKEN = `hls_${"a".repeat(48)}`;

function visit(query: string, cookie = false): Response {
  const request = new NextRequest(
    `http://localhost/c/${TOKEN}/view${query}`,
    cookie ? { headers: { cookie: `${SHARE_VIEW_GATE_COOKIE}=1` } } : undefined,
  );
  return proxy(request) as Response;
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "", "http://localhost");
}

describe("the share page gate", () => {
  it("explains instead of looping when the route's fresh hop arrives without its cookie", () => {
    const res = visit(`?via=${Date.now()}`);
    expect(res.status).toBe(307);
    const back = location(res);
    expect(back.pathname).toBe(`/c/${TOKEN}`);
    expect(back.searchParams.get("cookies")).toBe("off");
  });

  it("sends a visit without a hop, or on an old one, back through the gate", () => {
    for (const query of [
      "",
      `?via=${Date.now() - SHARE_VIEW_HOP_WINDOW_MS - 1000}`,
      "?via=yesterday",
    ]) {
      const back = location(visit(query));
      expect(back.pathname).toBe(`/c/${TOKEN}`);
      expect(back.searchParams.has("cookies")).toBe(false);
    }
  });

  it("lets a visit with the cookie through to the page", () => {
    const res = visit(`?via=${Date.now()}`, true);
    expect(res.headers.get("location")).toBeNull();
  });

  it("reads only a hop the route could have made", () => {
    const now = 1_790_000_000_000;
    expect(isFreshShareViewHop(String(now - 1_000), now)).toBe(true);
    expect(isFreshShareViewHop(String(now + 60_000), now)).toBe(false);
    expect(isFreshShareViewHop("1e12", now)).toBe(false);
    expect(isFreshShareViewHop(null, now)).toBe(false);
  });
});
