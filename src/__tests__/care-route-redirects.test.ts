/**
 * The preventive-care page lives at `/care`; every address it had before keeps
 * working.
 *
 * It started as `/vorsorge`, became `/checkups` and then `/care`. Push
 * notifications already delivered to a phone, the PWA's cached
 * navigation and bookmarks still carry the older paths, usually with a query
 * (`?visit=<id>`, `?view=visits`). This runs each one through the redirects
 * in `next.config.ts` with Next.js's own matcher and destination builder, so
 * the assertion is the URL the browser is actually sent to: a permanent (308)
 * redirect to the same place under `/care`, query string intact, in one hop.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { getRedirectStatus } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { prepareDestination } from "next/dist/shared/lib/router/utils/prepare-destination";

import nextConfig from "../../next.config";

interface Redirect {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
}

async function redirects(): Promise<Redirect[]> {
  return ((await nextConfig.redirects?.()) ?? []) as Redirect[];
}

/** Where one request is sent, the way the Next.js router resolves it. */
function follow(
  all: readonly Redirect[],
  url: string,
): { status: number; location: string } | null {
  const parsed = new URL(url, "https://health.example");
  const query = Object.fromEntries(parsed.searchParams);
  for (const route of all) {
    const params = getPathMatch(route.source, {
      removeUnnamedParams: true,
      strict: true,
    })(parsed.pathname);
    if (!params) continue;
    const { parsedDestination } = prepareDestination({
      appendParamsToQuery: false,
      destination: route.destination,
      params,
      query,
    });
    const search = new URLSearchParams(
      parsedDestination.query as Record<string, string>,
    ).toString();
    return {
      status: getRedirectStatus(route),
      location: `${parsedDestination.pathname}${search ? `?${search}` : ""}`,
    };
  }
  return null;
}

const APP = join(process.cwd(), "src/app");

describe("old preventive-care addresses", () => {
  it.each([
    ["/checkups", "/care"],
    ["/checkups?visit=v1", "/care?visit=v1"],
    ["/checkups?view=visits", "/care?view=visits"],
    ["/checkups?site=Knee&side=LEFT", "/care?site=Knee&side=LEFT"],
    ["/checkups/practitioners", "/care/practitioners"],
    ["/vorsorge", "/care"],
    ["/vorsorge?visit=v1", "/care?visit=v1"],
    ["/vorsorge/practitioners", "/care/practitioners"],
  ])("%s answers 308 to %s", async (from, to) => {
    const all = await redirects();
    expect(follow(all, from)).toEqual({ status: 308, location: to });
  });

  it("sends the new address nowhere", async () => {
    const all = await redirects();
    expect(follow(all, "/care")).toBeNull();
    expect(follow(all, "/care?visit=v1")).toBeNull();
    expect(follow(all, "/care/practitioners")).toBeNull();
  });

  it("leaves the API alone", async () => {
    const all = await redirects();
    expect(follow(all, "/api/measurement-reminders")).toBeNull();
    expect(follow(all, "/checkupsx")).toBeNull();
  });

  it("lands on pages that exist, and the old directory is gone", () => {
    expect(existsSync(join(APP, "care/page.tsx"))).toBe(true);
    expect(existsSync(join(APP, "care/practitioners/page.tsx"))).toBe(true);
    expect(existsSync(join(APP, "checkups"))).toBe(false);
    expect(existsSync(join(APP, "vorsorge"))).toBe(false);
  });

  it("the matcher is live: a made-up address finds no redirect", async () => {
    const all = await redirects();
    expect(all.length).toBeGreaterThan(10);
    expect(follow(all, "/no-such-page")).toBeNull();
  });
});
