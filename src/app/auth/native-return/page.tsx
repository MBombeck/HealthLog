import type { Metadata } from "next";

import { NativeReturnNotice } from "@/components/auth/native-return-notice";

/**
 * #163 B2 — the native sign-in's opt-in https return.
 *
 * An app build with an associated domain for this instance starts its SSO
 * sign-in with `return=https`; the callback then ends here, on
 * `/auth/native-return?code=hlh_…` (or `?mfa_ticket=…&methods=…`, or
 * `?error=…[&purgeAt=…]`), instead of on `healthlog://oidc-callback`. The app
 * intercepts the address before it loads. This page is what a browser without
 * the app shows: a fixed "back to the app" message.
 *
 * A URL-credential surface by design (`session-surface-guard.test.ts`, S2,
 * leg 4). The page never reads its query, so the code is rendered into
 * nothing: not the markup, not the RSC payload, not a link. The client part
 * removes the query from the address bar as soon as it runs. The code alone is
 * worthless anyway: single-use, five minutes, and bound to the app's PKCE
 * verifier, which never leaves the device. The edge marks the address
 * uncacheable, unindexable and `Referrer-Policy: no-referrer`
 * (`path-credential-headers.ts`), and the page loads nothing from another
 * origin.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function NativeReturnPage() {
  return <NativeReturnNotice />;
}
