import { describe, expect, it } from "vitest";

import {
  GOOGLE_HEALTH_CORE_SCOPES,
  getGoogleHealthScopeString,
  resolveGoogleHealthScopes,
} from "@/lib/google-health/oauth";

describe("Google Health scope resolver", () => {
  it("ships exactly the four core Restricted read scopes", () => {
    const scopes = resolveGoogleHealthScopes();
    expect(scopes).toEqual([...GOOGLE_HEALTH_CORE_SCOPES]);
    expect(scopes).toHaveLength(4);
    // Every core scope is a Restricted read-only googlehealth scope.
    for (const s of scopes) {
      expect(s).toMatch(
        /^https:\/\/www\.googleapis\.com\/auth\/googlehealth\..+\.readonly$/,
      );
    }
  });

  it("requests no ECG/IRN Restricted scope (no reader consumes them yet)", () => {
    for (const s of resolveGoogleHealthScopes()) {
      expect(s).not.toContain("googlehealth.ecg");
      expect(s).not.toContain("googlehealth.irn");
    }
  });

  it("joins the resolved scopes with a single space for the authorize request", () => {
    expect(getGoogleHealthScopeString()).toBe(
      GOOGLE_HEALTH_CORE_SCOPES.join(" "),
    );
    expect(getGoogleHealthScopeString().split(" ")).toHaveLength(4);
  });
});
