/**
 * Every path published after v1.49.0 is named by a server feature key, or
 * says why a client never needs one.
 *
 * The native app shows a capability only when `GET /api/version` lists its
 * key in `features` (`src/lib/server-features.ts`), because an app build
 * outlives the server it was built against and must not offer a route an
 * older server lacks. A route that ships without a key is therefore a route
 * the app keeps hidden, and nothing else in the gate notices: the contract is
 * complete, the route works, the app stays silent. The model-free lab reader
 * shipped that way.
 *
 * The rule here: a path in the published contract that the last release
 * before keys were required did not have (the frozen list in
 * `fixtures/openapi-paths-v1.49.0.json`, taken from that tag's `docs/api/openapi.yaml`, since CI checks out without tags)
 * is either in {@link FEATURE_KEY_PATHS} under the key that announces it, or
 * in {@link NO_FEATURE_KEY} with the reason no client gates on it. Both lists
 * are held against the contract in turn, so neither can name a path that is
 * gone. A behaviour that adds no path (a new field, a new mode) is not seen
 * here; its key is a judgement made in `server-features.ts`.
 */
import { describe, expect, it } from "vitest";

import baseline from "./fixtures/openapi-paths-v1.49.0.json";
import { openApiPaths } from "@/lib/openapi/routes";
import { SERVER_FEATURES, type ServerFeature } from "@/lib/server-features";

/** Paths added since v1.49.0, by the key that tells a client they exist. */
const FEATURE_KEY_PATHS: Record<string, ServerFeature> = {
  "/api/daily/morning": "daily.morning",
  "/api/health-connect/pairing": "health-connect.sync",
  "/api/health-connect/pair": "health-connect.sync",
  "/api/health-connect/state": "health-connect.sync",
  "/api/health-connect/batch": "health-connect.sync",
  "/api/auth/me/dismissed-hints": "account.dismissed-hints",
  "/api/insights/context": "insights.chart-context",
  "/api/documents/inbound/{id}/lab-values": "documents.lab-values-extract",
  "/api/treatment-series": "care.treatment-series",
  "/api/treatment-series/{id}": "care.treatment-series",
  "/api/treatment-series/{id}/restore": "care.treatment-series",
  "/api/emergency-card/wallet/apple": "profile.emergency-card-apple-wallet",
  "/api/emergency-card/wallet/apple/relay-hint":
    "profile.emergency-card-apple-wallet-state",
  "/api/emergency-card/wallet/apple/ready-push/dismiss":
    "profile.emergency-card-wallet-ready-push",
  "/api/emergency-card/wallet/apple/pass":
    "profile.emergency-card-apple-wallet",
};

/** Paths added since v1.49.0 that no client gates on, each with its reason. */
const NO_FEATURE_KEY: Record<string, string> = {
  "/api/auth/password-strength":
    "Advisory only: the web forms' strength meter. A client facing an older server shows no meter and loses nothing, because the password is scored again on submit.",
  "/api/auth/register/setup":
    "Browser-only first-run claim: it sets a cookie for the browser that creates an empty instance's first account; a native client signs in to an instance that already has one.",
  "/api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}/{serial}":
    "Apple Wallet's pass web service, called by Wallet itself from the pass's webServiceURL, never by the app.",
  "/api/wallet/apple/v1/devices/{deviceId}/registrations/{passTypeId}":
    "Apple Wallet's pass web service, called by Wallet itself from the pass's webServiceURL, never by the app.",
  "/api/wallet/apple/v1/passes/{passTypeId}/{serial}":
    "Apple Wallet's pass web service, called by Wallet itself from the pass's webServiceURL, never by the app.",
  "/api/wallet/apple/v1/log":
    "Apple Wallet's pass web service, called by Wallet itself from the pass's webServiceURL, never by the app.",
};

const published = Object.keys(openApiPaths);
const before = new Set<string>(baseline);

describe("server feature keys cover every new path", () => {
  it("the baseline is the v1.49.0 contract, not an empty list", () => {
    expect(before.size).toBe(573);
  });

  it("every path added since v1.49.0 has a key or a reason", () => {
    const added = published.filter((path) => !before.has(path));
    expect(added.length).toBeGreaterThan(0);
    const unaccounted = added.filter(
      (path) => !(path in FEATURE_KEY_PATHS) && !(path in NO_FEATURE_KEY),
    );
    expect(
      unaccounted,
      "A new path needs a key in src/lib/server-features.ts and an entry in FEATURE_KEY_PATHS, or an entry in NO_FEATURE_KEY saying why no client gates on it",
    ).toEqual([]);
  });

  it("both lists name only new, published paths, never both at once", () => {
    for (const path of [
      ...Object.keys(FEATURE_KEY_PATHS),
      ...Object.keys(NO_FEATURE_KEY),
    ]) {
      expect(published, path).toContain(path);
      expect(before.has(path), path).toBe(false);
      expect(path in FEATURE_KEY_PATHS && path in NO_FEATURE_KEY, path).toBe(
        false,
      );
    }
  });

  it("every mapped key is published, and every reason says something", () => {
    for (const key of Object.values(FEATURE_KEY_PATHS)) {
      expect(SERVER_FEATURES).toContain(key);
    }
    for (const reason of Object.values(NO_FEATURE_KEY)) {
      expect(reason.length).toBeGreaterThan(30);
    }
  });
});
