import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PrivacyPage from "../page";

/**
 * v1.4.26 — Public privacy-policy page contract.
 *
 * The page is the App-Store-submission blocker (Apple BLOCKER 2 of 5).
 * These tests pin the structural commitments that any future redesign
 * must preserve:
 *
 *   1. The H1 says "Privacy Policy".
 *   2. The page advertises a "Last updated" date alongside a policy
 *      version stamp — App-Store reviewers and German DPA inspectors
 *      use both to gauge currency.
 *   3. Every Apple-HealthKit type the iOS application reads is
 *      enumerated verbatim by identifier. Drift from the iOS source
 *      (`HealthKitWireConverter.swift` + `HealthKitService.swift`)
 *      would be a compliance hole.
 *   4. The numbered section headings are all present, so the policy
 *      remains scannable without re-rendering with a specific locale.
 */

function render() {
  return renderToStaticMarkup(<PrivacyPage />);
}

describe("<PrivacyPage>", () => {
  it("renders without crashing and includes the H1", () => {
    const html = render();
    expect(html).toContain("Privacy Policy");
  });

  it("advertises the policy version + last-updated date", () => {
    const html = render();
    expect(html).toContain("Policy version 1.4.26");
    expect(html).toContain("Last updated: 2026-05-15");
    expect(html).toContain('data-slot="privacy-last-updated"');
  });

  it("renders the numbered section headings", () => {
    const html = render();
    // 11 numbered sections — H2 headings render the leading numeral so
    // the reader can navigate without an explicit table of contents.
    const expectedHeadings = [
      "1. Overview",
      "2. Data we collect",
      "3. Why we collect each category",
      "4. Third-party sub-processors",
      "5. Data storage and retention",
      "6. Your rights (GDPR Art. 15-22, DSGVO)",
      "7. Medical-device boundary (EU MDR 2017/745, MDCG 2021-24)",
      "8. Apple App Store privacy categories",
      "9. Children",
      "10. Changes to this policy",
      "11. Contact",
    ];
    for (const heading of expectedHeadings) {
      expect(html, `missing H2 ${JSON.stringify(heading)}`).toContain(heading);
    }
  });

  it("enumerates every HealthKit quantity type read by the iOS app", () => {
    const html = render();
    // Source of truth: HealthKitService.defaultReadTypes +
    // HealthKitWireConverter.preferredUnit in the iOS repo. Every
    // identifier the iOS app reads must appear verbatim so an App
    // Store reviewer can confirm coverage. The list must stay sorted
    // by category in the page itself (vitals, cardio, activity,
    // audio, daylight) — that's a UX commitment, not a test
    // commitment; we just check membership here.
    const requiredIdentifiers = [
      // Vitals (point metrics)
      "bodyMass",
      "bodyFatPercentage",
      "bodyTemperature",
      "bloodPressureSystolic",
      "bloodPressureDiastolic",
      "bloodGlucose",
      "oxygenSaturation",
      // Cardio
      "heartRate",
      "restingHeartRate",
      "heartRateVariabilitySDNN",
      "vo2Max",
      // Activity
      "stepCount",
      "activeEnergyBurned",
      "flightsClimbed",
      "distanceWalkingRunning",
      // Audio exposure
      "environmentalAudioExposure",
      "headphoneAudioExposure",
      // Time in Daylight (iOS 17+)
      "timeInDaylight",
    ];
    expect(
      requiredIdentifiers.length,
      "at least 17 HealthKit quantity identifiers must be enumerated",
    ).toBeGreaterThanOrEqual(17);
    for (const identifier of requiredIdentifiers) {
      expect(
        html,
        `missing HealthKit identifier ${JSON.stringify(identifier)}`,
      ).toContain(identifier);
    }
  });

  it("lists sleepAnalysis as the sole HKCategoryTypeIdentifier read", () => {
    const html = render();
    expect(html).toContain("sleepAnalysis");
    // Per-stage breakdown is the differentiator vs. a single sleep
    // duration — name the four stage labels so the disclosure stays
    // explicit.
    expect(html).toContain("Awake");
    expect(html).toContain("REM");
    expect(html).toContain("Core");
    expect(html).toContain("Deep");
  });

  it("names every active sub-processor", () => {
    const html = render();
    const expectedProviders = [
      "Anthropic",
      "OpenAI",
      "Withings",
      "Apple, Inc.",
      "Telegram",
      "GitHub",
      "Cloudflare",
      "Hetzner",
    ];
    for (const provider of expectedProviders) {
      expect(
        html,
        `missing sub-processor ${JSON.stringify(provider)}`,
      ).toContain(provider);
    }
  });

  it("states the EU MDR medical-device boundary verbatim", () => {
    const html = render();
    expect(html).toContain("not a medical device");
    expect(html).toContain("2017/745");
    expect(html).toContain("MDCG 2021-24");
  });

  it("links to the GDPR-request contact channel without exposing PII", () => {
    const html = render();
    expect(html).toContain("github.com/MBombeck/HealthLog/issues");
    // Marc-Voice rule: no personal name in user-facing artefacts. The
    // policy must speak in terms of "the operator" / "the maintainer"
    // not Marc's full name.
    expect(html).not.toMatch(/Marc[- ]?Andr/i);
    expect(html).not.toContain("Bombeck ");
  });

  it("renders a discoverable footer with the version and license", () => {
    const html = render();
    expect(html).toContain('data-slot="privacy-footer"');
    expect(html).toContain("AGPL-3.0");
    expect(html).toContain("1.4.26");
  });
});
