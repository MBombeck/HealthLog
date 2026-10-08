/**
 * The OAuth callback URL each BYO-key provider registers, resolved on the
 * server at request time.
 *
 * Settings → Integrations shows two things built from this value: the
 * copyable callback address in the redirect guide, and the notice that warns
 * when the configured callback origin differs from the origin the browser is
 * on. Both used to read `process.env.NEXT_PUBLIC_APP_URL` inside a
 * `"use client"` module. Next.js inlines `NEXT_PUBLIC_*` into client bundles
 * at build time, and the published image is built without that variable, so
 * every self-hoster's bundle carried an empty base: the guide showed a bare
 * path and the notice never rendered. Resolving here, in server code, reads
 * the runtime env the operator actually set.
 *
 * Each entry is the exact value the provider's client sends as `redirect_uri`
 * on the wire, through the same function, so what the page shows and what the
 * handshake registers cannot drift apart. Fitbit and Google Health validate
 * their URI and throw on a malformed configuration; here that surfaces as
 * `null` (nothing would be registered), and the cards fall back to the fixed
 * path for the guide and skip the origin comparison.
 */

import { getFitbitRedirectUri } from "@/lib/fitbit/client";
import { getGoogleHealthRedirectUri } from "@/lib/google-health/client";
import { getOuraRedirectUri } from "@/lib/oura/client";
import { getPolarRedirectUri } from "@/lib/polar/client";
import { getStravaRedirectUri } from "@/lib/strava/client";
import { getWhoopRedirectUri } from "@/lib/whoop/client";
import { getWithingsRedirectUri } from "@/lib/withings/client";

export const INTEGRATION_CALLBACK_PROVIDERS = [
  "withings",
  "whoop",
  "fitbit",
  "google-health",
  "polar",
  "oura",
  "strava",
] as const;

export type IntegrationCallbackProvider =
  (typeof INTEGRATION_CALLBACK_PROVIDERS)[number];

/** `null` when the provider cannot produce a redirect URI from the current env. */
export type IntegrationCallbackUrls = Record<
  IntegrationCallbackProvider,
  string | null
>;

const RESOLVERS: Record<IntegrationCallbackProvider, () => string> = {
  withings: getWithingsRedirectUri,
  whoop: getWhoopRedirectUri,
  fitbit: getFitbitRedirectUri,
  "google-health": getGoogleHealthRedirectUri,
  polar: getPolarRedirectUri,
  oura: getOuraRedirectUri,
  strava: getStravaRedirectUri,
};

function resolve(provider: IntegrationCallbackProvider): string | null {
  try {
    const url = RESOLVERS[provider]();
    // Some resolvers splice an unset NEXT_PUBLIC_APP_URL into the template
    // and hand back "undefined/api/…/callback". That is not a URL anyone can
    // paste into a vendor form; report it as not configured so the card
    // shows the path instead.
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

export function getIntegrationCallbackUrls(): IntegrationCallbackUrls {
  return {
    withings: resolve("withings"),
    whoop: resolve("whoop"),
    fitbit: resolve("fitbit"),
    "google-health": resolve("google-health"),
    polar: resolve("polar"),
    oura: resolve("oura"),
    strava: resolve("strava"),
  };
}
