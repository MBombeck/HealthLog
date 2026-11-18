import { NextResponse } from "next/server";

import { NATIVE_OIDC_RETURN_PATH } from "@/lib/auth/native-return";

/**
 * Apple App Site Association (AASA) handler.
 *
 * Apple fetches `/.well-known/apple-app-site-association` over HTTPS
 * without credentials, with no extension and with a strict
 * `application/json` Content-Type expectation. iOS uses the body to:
 *   - Wire Universal Links so the addresses the app handles open straight
 *     in it instead of Safari (SB-4, v1.4.40). Only those addresses are
 *     listed (#163 B3): the registration and invite links, and the native
 *     sign-in's https return. Every other address, the web sign-in's own
 *     SSO return among them, stays in the browser for a build that adds
 *     `applinks:` for an instance.
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
 * Every host serving this app (an operator's instance, the public demo)
 * shares this handler — the response is host-independent.
 */
const AASA_APP_ID = "S8WDX4W5KX.dev.healthlog.app";

/**
 * The paths the app handles. The native return is the same constant the
 * callback redirects to and `GET /api/auth/oidc/status` announces.
 */
const AASA_PATHS = ["/auth/register*", "/invite*", NATIVE_OIDC_RETURN_PATH];

const AASA = {
  applinks: {
    details: [
      {
        appID: AASA_APP_ID,
        paths: AASA_PATHS,
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
