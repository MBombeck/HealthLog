import { describe, expect, it } from "vitest";

/**
 * SB-4 (v1.4.40) — Apple App Site Association (AASA) handler contract.
 *
 * iOS Universal Links and Web Credentials both fetch
 * `/.well-known/apple-app-site-association` without credentials and feed
 * the body to Apple's swcd / aasa-validator. Both pieces of Apple
 * tooling are strict about three things:
 *
 *   1. The exact JSON shape — `applinks.details[].appID` (the
 *      `<TeamID>.<BundleID>` prefix) plus `applinks.details[].paths`
 *      (the URL-prefix allow-list), and `webcredentials.apps` (the same
 *      App ID prefix) for passkey origin-sharing.
 *   2. The `Content-Type` header — must be `application/json` *without*
 *      a `charset` parameter. `application/json; charset=utf-8` makes
 *      Apple's CDN proxy refuse to mirror the file, which silently
 *      breaks Universal Links on every device.
 *   3. The response answers 200 to an unauthenticated GET (covered by
 *      `proxy-well-known-public.test.ts` at the proxy layer).
 *
 * This file pins (1) and (2). Any drift means iOS PB30 (App-Store
 * submission) regresses without a CI signal.
 */

import { GET } from "@/app/.well-known/apple-app-site-association/route";

const APP_ID = "S8WDX4W5KX.dev.healthlog.app";

describe("/.well-known/apple-app-site-association (SB-4)", () => {
  it("answers 200", async () => {
    const res = GET();
    expect(res.status).toBe(200);
  });

  it("uses Content-Type: application/json with no charset", async () => {
    const res = GET();
    const contentType = res.headers.get("content-type");
    // Apple's aasa-validator + swcd reject any `charset=…` parameter
    // on the AASA file. The handler MUST emit the bare media type.
    expect(contentType).toBe("application/json");
  });

  it("sets a Cache-Control directive that allows mirroring", async () => {
    const res = GET();
    const cacheControl = res.headers.get("cache-control");
    expect(cacheControl).toBeTruthy();
    // Public + max-age so Apple's CDN (one-hour TTL) can mirror the
    // file without falling back to private/no-store behaviour.
    expect(cacheControl).toMatch(/public/);
    expect(cacheControl).toMatch(/max-age=\d+/);
  });

  it("emits the SB-4 payload shape exactly", async () => {
    const res = GET();
    const body = await res.json();
    expect(body).toEqual({
      applinks: {
        details: [
          {
            appID: APP_ID,
            paths: ["*"],
          },
        ],
      },
      webcredentials: {
        apps: [APP_ID],
      },
    });
  });

  it("uses the same App ID prefix for applinks and webcredentials", async () => {
    // Apple's passkey origin-pairing requires the iOS bundle and the
    // website origin to advertise the same App ID. Splitting these two
    // entries (e.g. a stale Team ID on one side) breaks passkey login
    // without a redirect / status-code signal — the only symptom is a
    // silent fall-back to password login on iOS.
    const res = GET();
    const body = (await res.json()) as {
      applinks: { details: Array<{ appID: string }> };
      webcredentials: { apps: string[] };
    };
    expect(body.applinks.details[0].appID).toBe(body.webcredentials.apps[0]);
  });
});
