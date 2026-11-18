/**
 * v1.17.1 (04-M1) — the WHOOP OAuth callback redirects back with
 * `?whoop=connected|error&reason=<tag>`, but the settings page only read the
 * param for Withings/Polar/Oura — so a user returning from a WHOOP round-trip
 * landed on a silently unchanged page. These pin the four-provider outcome parsing + reason-key resolution.
 */
import { describe, it, expect } from "vitest";

import { parseOAuthOutcome, oauthReasonKey } from "../integrations-section";

describe("parseOAuthOutcome", () => {
  it("reads a connected outcome for every OAuth provider", () => {
    for (const p of [
      "polar",
      "oura",
      "whoop",
      "googleHealth",
      "strava",
    ] as const) {
      expect(parseOAuthOutcome(`?${p}=connected`)).toEqual({
        provider: p,
        kind: "connected",
      });
    }
  });

  it("reads WHOOP and Strava error outcomes with their reason tag (the gap fix)", () => {
    expect(parseOAuthOutcome("?whoop=error&reason=token")).toEqual({
      provider: "whoop",
      kind: "error",
      reason: "token",
    });
    expect(parseOAuthOutcome("?strava=error&reason=cross_user")).toEqual({
      provider: "strava",
      kind: "error",
      reason: "cross_user",
    });
  });

  it("defaults a missing reason to 'unknown'", () => {
    expect(parseOAuthOutcome("?whoop=error")).toEqual({
      provider: "whoop",
      kind: "error",
      reason: "unknown",
    });
  });

  it("returns null when no provider param is present", () => {
    expect(parseOAuthOutcome("?foo=bar")).toBeNull();
    expect(parseOAuthOutcome("")).toBeNull();
  });
});

describe("oauthReasonKey", () => {
  it("maps a known tag to the provider-specific key", () => {
    expect(oauthReasonKey("whoop", "token")).toBe(
      "settings.whoopOauthError.token",
    );
    expect(oauthReasonKey("whoop", "expired")).toBe(
      "settings.whoopOauthError.expired",
    );
  });

  it("names Oura's issuer refusal with its own copy, and only for Oura", () => {
    expect(oauthReasonKey("oura", "issuer")).toBe(
      "settings.ouraOauthError.issuer",
    );
    // No other callback emits it, and no other subtree carries the copy.
    expect(oauthReasonKey("polar", "issuer")).toBe(
      "settings.polarOauthError.generic",
    );
  });

  it("names an account already held by another record for every provider", async () => {
    const en = (await import("../../../../messages/en.json"))
      .default as unknown as {
      settings: Record<string, Record<string, string>>;
    };
    for (const provider of [
      "polar",
      "oura",
      "whoop",
      "googleHealth",
      "strava",
    ] as const) {
      const key = oauthReasonKey(provider, "already_linked");
      expect(key.endsWith(".already_linked")).toBe(true);
      const [, base] = key.split(".");
      expect(en.settings[base!]!.already_linked).toBeTruthy();
    }
    expect(en.settings.withingsOauthError!.already_linked).toBeTruthy();
  });

  it("falls back to generic for an unknown tag", () => {
    expect(oauthReasonKey("whoop", "totally_unknown")).toBe(
      "settings.whoopOauthError.generic",
    );
  });
});

describe("the Oura callback's reasons", () => {
  it("each has its own copy, none falls back to generic", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const route = readFileSync(
      join(process.cwd(), "src/app/api/oura/callback/route.ts"),
      "utf8",
    );
    const reasons = [...route.matchAll(/ERR\("([a-z_0-9]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(reasons).toContain("issuer");
    const en = JSON.parse(
      readFileSync(join(process.cwd(), "messages/en.json"), "utf8"),
    ) as { settings: { ouraOauthError: Record<string, string> } };
    for (const reason of reasons) {
      const key = oauthReasonKey("oura", reason);
      expect(key, reason).toBe(`settings.ouraOauthError.${reason}`);
      expect(en.settings.ouraOauthError[reason], reason).toBeTruthy();
    }
  });
});
