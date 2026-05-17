import { describe, expect, it } from "vitest";

import { resolveInitialTimezone } from "../account-section";

/**
 * v1.4.37 — silent browser-timezone auto-seed for the account
 * profile picker.
 *
 * The retired "Browser-Zeitzone übernehmen" button used to ask the
 * user to opt in; v1.4.37 seeds the form for them on first mount
 * whenever the stored value is still the Europe/Berlin default and
 * the browser reports a different IANA zone. The helper that drives
 * that decision is pure so the contract can be pinned without
 * mounting the full AccountSection component tree (which depends on
 * react-query, useAuth, next/navigation, etc.).
 */

describe("resolveInitialTimezone — v1.4.37 silent auto-seed", () => {
  it("pre-fills the browser zone when the stored value is the Berlin default and the browser is elsewhere", () => {
    expect(resolveInitialTimezone("Europe/Berlin", "America/New_York")).toBe(
      "America/New_York",
    );
  });

  it("pre-fills the browser zone when the stored value is null and the browser is elsewhere", () => {
    expect(resolveInitialTimezone(null, "Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("pre-fills the browser zone when the stored value is an empty string and the browser is elsewhere", () => {
    expect(resolveInitialTimezone("", "Europe/London")).toBe("Europe/London");
  });

  it("keeps Berlin when the browser is also Berlin (no seed needed)", () => {
    expect(resolveInitialTimezone("Europe/Berlin", "Europe/Berlin")).toBe(
      "Europe/Berlin",
    );
  });

  it("keeps Berlin when the browser detection returned an empty string", () => {
    // detectBrowserTimezone falls back to Europe/Berlin on engines
    // without Intl.DateTimeFormat, but guard against future shapes
    // that hand back an empty string.
    expect(resolveInitialTimezone("Europe/Berlin", "")).toBe("Europe/Berlin");
  });

  it("respects any non-Berlin stored value — explicit user choice wins over browser detection", () => {
    expect(
      resolveInitialTimezone("America/Los_Angeles", "Europe/Berlin"),
    ).toBe("America/Los_Angeles");
  });

  it("respects a non-Berlin stored value even when the browser reports a different non-Berlin zone", () => {
    // User stored Pacific, then opened the form from a hotel in
    // Tokyo. The stored value still wins; the user can change it
    // explicitly via the picker if they want.
    expect(resolveInitialTimezone("America/Los_Angeles", "Asia/Tokyo")).toBe(
      "America/Los_Angeles",
    );
  });
});
