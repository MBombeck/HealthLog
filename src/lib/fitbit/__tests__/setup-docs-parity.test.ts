import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GOOGLE_HEALTH_CORE_SCOPES } from "@/lib/google-health/oauth";

import { FITBIT_OAUTH_SCOPE } from "@/lib/fitbit/oauth";

/**
 * Guard against the class of bug reported in #396: the setup docs drifting away
 * from what the code actually does. The Fitbit integration uses the CLASSIC
 * Fitbit Web API (an app from dev.fitbit.com), not a Google Cloud OAuth client —
 * a doc that says otherwise sends users to the wrong registry and fails with
 * `unauthorized_client — Invalid client_id`.
 */
const readDoc = (name: string): string =>
  readFileSync(join(process.cwd(), "docs", "integrations", name), "utf8");

describe("Fitbit setup docs stay in sync with the code", () => {
  const fitbitDoc = readDoc("fitbit.md");

  it("documents every OAuth scope the client actually requests", () => {
    for (const scope of FITBIT_OAUTH_SCOPE.split(" ")) {
      expect(fitbitDoc).toContain(scope);
    }
  });

  it("points at the classic Fitbit endpoints and dev.fitbit.com", () => {
    expect(fitbitDoc).toContain("dev.fitbit.com");
    expect(fitbitDoc).toContain("www.fitbit.com/oauth2/authorize");
    expect(fitbitDoc).toContain("api.fitbit.com/oauth2/token");
    expect(fitbitDoc).toContain("/api/fitbit/callback");
  });

  it("never instructs the user to create a Google Cloud OAuth client (the #396 mistake)", () => {
    // The "do this" markers of the wrong walkthrough: the Google Cloud console
    // and the Google Health scope URLs. Mentioning `apps.googleusercontent.com`
    // as a "don't paste this" warning is allowed and intentional.
    expect(fitbitDoc).not.toContain("console.cloud.google");
    expect(fitbitDoc).not.toContain("googleapis.com/auth/googlehealth");
  });

  it("keeps the Google Health runbook on Google endpoints (the inverse mix-up)", () => {
    // Since v1.27.0 google-health.md documents the real Google Health
    // integration — a Google Cloud OAuth client. The guard flips: this page
    // must never send the user to the classic Fitbit app registry, and the
    // scopes it lists must match what the google-health client requests.
    const googleHealthDoc = readDoc("google-health.md");
    expect(googleHealthDoc).toContain("accounts.google.com/o/oauth2/v2/auth");
    for (const scope of GOOGLE_HEALTH_CORE_SCOPES) {
      expect(googleHealthDoc).toContain(scope);
    }
    expect(googleHealthDoc).not.toContain("dev.fitbit.com");
    expect(googleHealthDoc).not.toContain("fitbit.com/oauth2/authorize");
  });
});
