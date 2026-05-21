import { NextResponse } from "next/server";

/**
 * Apple App Site Association (AASA) handler.
 *
 * Apple fetches `/.well-known/apple-app-site-association` over HTTPS
 * without credentials, with no extension and with a strict
 * `application/json` Content-Type expectation. iOS uses the body to:
 *   - Wire Universal Links so HealthLog URLs open straight in the iOS
 *     app instead of Safari (SB-4, v1.4.40). The `["*"]` matcher accepts
 *     every path on the host — the iOS side decides which routes it
 *     actually handles via its scene delegate.
 *   - Wire Web Credentials so the website origin and the iOS bundle
 *     share passkey ceremonies (HealthLog passkeys live at
 *     `/api/auth/passkey/*`, so the origins must match the same App ID).
 *
 * The `appID` / `webcredentials.apps` entry is the App ID prefix
 * (`<TeamID>.<BundleID>`) for the HealthLog iOS app. Apple bundles the
 * file on its CDN proxy
 * (`https://app-site-association.cdn-apple.com/a/v1/<host>`) and serves
 * it to devices, so the origin only needs to respond reliably; Apple's
 * one-hour CDN TTL pairs with the `Cache-Control` directive below.
 *
 * Both `healthlog.bombeck.io` (maintainer prod) and `demo.healthlog.dev`
 * (demo) share this handler — the response is host-independent.
 */
const AASA_APP_ID = "S8WDX4W5KX.dev.healthlog.app";

const AASA = {
  applinks: {
    details: [
      {
        appID: AASA_APP_ID,
        paths: ["*"],
      },
    ],
  },
  webcredentials: {
    apps: [AASA_APP_ID],
  },
};

export function GET() {
  return NextResponse.json(AASA, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
