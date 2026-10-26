/**
 * The compose file passes every whitelisted variable through, so an unset
 * redirect URI reaches the process as an empty string. Every integration
 * treats an empty or blank value as unset and derives the callback from
 * `NEXT_PUBLIC_APP_URL`: Withings used to send `redirect_uri=` and Fitbit and
 * Google Health refused to start the handshake as "not configured".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { withingsOAuth } from "@/lib/withings/oauth";
import { fitbitOAuth } from "@/lib/fitbit/oauth";
import { googleHealthOAuth } from "@/lib/google-health/oauth";
import { polarOAuth } from "@/lib/polar/oauth";
import { whoopOAuth } from "@/lib/whoop/oauth";
import { stravaOAuth } from "@/lib/strava/oauth";
import { ouraOAuth } from "@/lib/oura/oauth";

const APP = "https://health.example.test";

const CASES: Array<[string, string, () => string, string]> = [
  ["Withings", "WITHINGS_REDIRECT_URI", withingsOAuth.redirectUri, "withings"],
  ["Fitbit", "FITBIT_REDIRECT_URI", fitbitOAuth.redirectUri, "fitbit"],
  [
    "Google Health",
    "GOOGLE_HEALTH_REDIRECT_URI",
    googleHealthOAuth.redirectUri,
    "google-health",
  ],
  ["Polar", "POLAR_REDIRECT_URI", polarOAuth.redirectUri, "polar"],
  ["WHOOP", "WHOOP_REDIRECT_URI", whoopOAuth.redirectUri, "whoop"],
  ["Strava", "STRAVA_REDIRECT_URI", stravaOAuth.redirectUri, "strava"],
  ["Oura", "OURA_REDIRECT_URI", ouraOAuth.redirectUri, "oura"],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(CASES)("%s redirect URI", (_name, variable, resolve, path) => {
  it.each(["", "   "])(
    "derives the callback when the variable is %j",
    (value) => {
      vi.stubEnv(variable, value);
      vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
      expect(resolve()).toBe(`${APP}/api/${path}/callback`);
    },
  );

  it("uses an explicit value, trimmed", () => {
    const explicit = `${APP}/api/${path}/callback`;
    vi.stubEnv(variable, ` ${explicit} `);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    expect(resolve()).toBe(explicit);
  });
});

describe("with neither variable set", () => {
  it.each([
    ["Fitbit", "FITBIT_REDIRECT_URI", fitbitOAuth.redirectUri],
    [
      "Google Health",
      "GOOGLE_HEALTH_REDIRECT_URI",
      googleHealthOAuth.redirectUri,
    ],
  ] as const)("%s still says it is not configured", (_n, variable, resolve) => {
    vi.stubEnv(variable, "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " ");
    expect(() => resolve()).toThrow(/not configured/);
  });
});
