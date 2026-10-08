/**
 * `getIntegrationCallbackUrls()` must hand the Settings → Integrations cards
 * the exact `redirect_uri` each provider's client registers: the explicit
 * `<PROVIDER>_REDIRECT_URI` when the operator set one, the
 * `${NEXT_PUBLIC_APP_URL}/api/<provider>/callback` form otherwise. The map
 * goes through the provider functions themselves rather than restating the
 * rule, so this test pins that the wiring reaches every provider and that a
 * provider whose validation throws surfaces as `null` instead of taking the
 * page down.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INTEGRATION_CALLBACK_PROVIDERS,
  getIntegrationCallbackUrls,
} from "../callback-urls";

const OVERRIDE_VARS: Record<
  (typeof INTEGRATION_CALLBACK_PROVIDERS)[number],
  string
> = {
  withings: "WITHINGS_REDIRECT_URI",
  whoop: "WHOOP_REDIRECT_URI",
  fitbit: "FITBIT_REDIRECT_URI",
  "google-health": "GOOGLE_HEALTH_REDIRECT_URI",
  polar: "POLAR_REDIRECT_URI",
  oura: "OURA_REDIRECT_URI",
  strava: "STRAVA_REDIRECT_URI",
};

const TOUCHED = ["NEXT_PUBLIC_APP_URL", ...Object.values(OVERRIDE_VARS)];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getIntegrationCallbackUrls", () => {
  it("derives ${NEXT_PUBLIC_APP_URL}/api/<provider>/callback when nothing overrides it", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://health.example";
    const urls = getIntegrationCallbackUrls();
    for (const provider of INTEGRATION_CALLBACK_PROVIDERS) {
      expect(urls[provider], provider).toBe(
        `https://health.example/api/${provider}/callback`,
      );
    }
  });

  it("lets the explicit <PROVIDER>_REDIRECT_URI win over the derived form", () => {
    // Withings / WHOOP / Polar / Oura / Strava accept any explicit value.
    process.env.NEXT_PUBLIC_APP_URL = "https://health.example";
    for (const provider of [
      "withings",
      "whoop",
      "polar",
      "oura",
      "strava",
    ] as const) {
      process.env[OVERRIDE_VARS[provider]] =
        `https://edge.example/api/${provider}/callback`;
    }
    const urls = getIntegrationCallbackUrls();
    for (const provider of [
      "withings",
      "whoop",
      "polar",
      "oura",
      "strava",
    ] as const) {
      expect(urls[provider], provider).toBe(
        `https://edge.example/api/${provider}/callback`,
      );
    }
    // No override for these two, so they still derive.
    expect(urls.fitbit).toBe("https://health.example/api/fitbit/callback");
    expect(urls["google-health"]).toBe(
      "https://health.example/api/google-health/callback",
    );
  });

  it("uses the explicit Fitbit / Google Health override when the app URL is unset", () => {
    // Those two pin an explicit override to the app origin when both are set;
    // with only the override present it is taken verbatim.
    process.env.FITBIT_REDIRECT_URI =
      "https://edge.example/api/fitbit/callback";
    process.env.GOOGLE_HEALTH_REDIRECT_URI =
      "https://edge.example/api/google-health/callback";
    const urls = getIntegrationCallbackUrls();
    expect(urls.fitbit).toBe("https://edge.example/api/fitbit/callback");
    expect(urls["google-health"]).toBe(
      "https://edge.example/api/google-health/callback",
    );
  });

  it("reports null for a provider whose redirect URI fails validation, leaving the rest intact", () => {
    // Fitbit refuses a plain-http, non-loopback origin; the others do not
    // validate and keep deriving.
    process.env.NEXT_PUBLIC_APP_URL = "http://health.example";
    const urls = getIntegrationCallbackUrls();
    expect(urls.fitbit).toBeNull();
    expect(urls["google-health"]).toBeNull();
    expect(urls.withings).toBe("http://health.example/api/withings/callback");
    expect(urls.whoop).toBe("http://health.example/api/whoop/callback");
  });

  it("reports null rather than 'undefined/api/…' when the app URL is unset", () => {
    // A resolver that splices the unset variable into its template would
    // otherwise hand the card "undefined/api/polar/callback" to show.
    const urls = getIntegrationCallbackUrls();
    for (const provider of INTEGRATION_CALLBACK_PROVIDERS) {
      expect(urls[provider] ?? "", provider).not.toMatch(/^undefined/);
      if (urls[provider] !== null) {
        expect(urls[provider], provider).toMatch(/^https?:\/\//);
      }
    }
  });
});
