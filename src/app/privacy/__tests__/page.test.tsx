import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PrivacyPage from "../page";

/**
 * v1.4.40 W-PRIVACY (SB-3) — Bilingual public privacy-policy contract.
 *
 * The page is the App-Store-submission blocker (Apple BLOCKER 2 of 5).
 * These tests pin the structural commitments that any future redesign
 * must preserve:
 *
 *   1. The H1 carries both the German and English title so an Apple US
 *      reviewer AND a German DPA reviewer recognise the document
 *      without locale switching.
 *   2. The page advertises a "Last updated" date alongside a policy
 *      version stamp — App-Store reviewers and German DPA inspectors
 *      use both to gauge currency.
 *   3. Every Apple-HealthKit type the iOS application reads is
 *      enumerated verbatim by identifier. Drift from the iOS source
 *      (`HealthKitWireConverter.swift` + `HealthKitService.swift`)
 *      would be a compliance hole.
 *   4. The numbered section headings are all present, German first with
 *      the English title beside it, so the scannable spine still matches
 *      the in-app `Settings → Privacy` link target and the table of
 *      contents.
 *   5. v1.4.40 SB-3 additions — consent receipt endpoint, TLS 1.3,
 *      operator email + deletion-route disclosure, retention windows.
 */

function render() {
  return renderToStaticMarkup(<PrivacyPage />);
}

const POLICY_VERSION = "1.37.12";
const LAST_UPDATED = "2026-08-11";

describe("<PrivacyPage>", () => {
  it("renders without crashing and includes the bilingual H1", () => {
    const html = render();
    // Single bilingual title — DE + EN side by side so a German DPA
    // and an Apple US reviewer both see the document is for them.
    expect(html).toContain("Datenschutzerklärung");
    expect(html).toContain("Privacy Policy");
  });

  it("advertises the policy version + last-updated date", () => {
    const html = render();
    expect(html).toContain(`Policy version ${POLICY_VERSION}`);
    // Each language writes the date its own way, on its own line.
    expect(html).toContain("Stand: 11. August 2026");
    expect(html).toContain("Last updated: 11 August 2026");
    expect(html).toContain(`dateTime="${LAST_UPDATED}"`);
    expect(html).toContain('data-slot="privacy-last-updated"');
  });

  it("renders the numbered section headings", () => {
    const html = render();
    // 11 numbered sections. The H2 leads in German, like the body under it,
    // and carries the English title after it so the English table of
    // contents and the in-app link target still scan the same spine.
    const expectedHeadings: Array<[string, string]> = [
      ["1. Überblick", "Overview"],
      ["2. Erhobene Daten", "Data we collect"],
      ["3. Zwecke der Verarbeitung", "Why we collect each category"],
      [
        "4. Auftragsverarbeiter und Drittanbieter",
        "Third-party sub-processors",
      ],
      [
        "5. Speicherung, Speicherdauer und Verschlüsselung",
        "Data storage and retention",
      ],
      [
        "6. Ihre Rechte (DSGVO Art. 15–22)",
        "Your rights (GDPR Art. 15-22, DSGVO)",
      ],
      [
        "7. Medizinprodukte-Grenze (EU-MDR 2017/745, MDCG 2021-24)",
        "Medical-device boundary (EU MDR 2017/745, MDCG 2021-24)",
      ],
      [
        "8. Apple-App-Store-Datenschutzkategorien",
        "Apple App Store privacy categories",
      ],
      ["9. Kinder", "Children"],
      ["10. Änderungen dieser Erklärung", "Changes to this policy"],
      ["11. Kontakt", "Contact"],
    ];
    for (const [de, en] of expectedHeadings) {
      expect(html, `missing H2 ${JSON.stringify(de)}`).toContain(
        `<span lang="de">${de.replaceAll("&", "&amp;")}</span>`,
      );
      expect(html, `missing English title ${JSON.stringify(en)}`).toContain(
        ` / ${en}`,
      );
    }
  });

  it("renders the bilingual section structure with DE + EN bodies", () => {
    const html = render();
    // Each section ships a `data-slot="privacy-section-de"` body and a
    // collapsible `data-slot="privacy-section-en"` translation. 11
    // sections total.
    const deSlotCount = (html.match(/data-slot="privacy-section-de"/g) ?? [])
      .length;
    const enSlotCount = (html.match(/data-slot="privacy-section-en"/g) ?? [])
      .length;
    expect(deSlotCount).toBe(11);
    expect(enSlotCount).toBe(11);
    // The English translation `<details>` carries the "English
    // translation" summary label so a reviewer can find it without
    // guessing.
    expect(html).toContain("English translation");
    // The German bodies are `lang="de"` so screen readers switch
    // pronunciation correctly.
    expect(html).toContain('lang="de"');
    expect(html).toContain('lang="en"');
  });

  it("enumerates every HealthKit quantity type read by the iOS app", () => {
    const html = render();
    // Source of truth: HealthKitService.defaultReadTypes +
    // HealthKitWireConverter.preferredUnit in the iOS repo. Every
    // identifier the iOS app reads must appear verbatim so an App
    // Store reviewer can confirm coverage.
    const requiredIdentifiers = [
      "bodyMass",
      "bodyFatPercentage",
      "bodyTemperature",
      "bloodPressureSystolic",
      "bloodPressureDiastolic",
      "bloodGlucose",
      "oxygenSaturation",
      "heartRate",
      "restingHeartRate",
      "heartRateVariabilitySDNN",
      "vo2Max",
      "stepCount",
      "activeEnergyBurned",
      "flightsClimbed",
      "distanceWalkingRunning",
      "environmentalAudioExposure",
      "headphoneAudioExposure",
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
      "Google LLC",
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
    expect(html).toContain("kein Medizinprodukt");
    expect(html).toContain("2017/745");
    expect(html).toContain("MDCG 2021-24");
  });

  it("discloses the HealthKit data-flow path (HK sample → HTTPS → server)", () => {
    const html = render();
    // SB-3 requirement 2: how HealthKit samples reach the server.
    expect(html).toContain("POST /api/measurements");
    expect(html).toContain("TLS 1.3");
  });

  it("discloses AI off-device transit with the named providers and consent gate", () => {
    const html = render();
    // SB-3 requirement 3: which AI providers receive prompts and the
    // explicit guarantees (no raw HK identifiers, off by default,
    // encrypted in transit).
    expect(html).toContain("off by default");
    expect(html).toContain(
      "raw HealthKit identifiers and raw sample IDs are not part",
    );
    expect(html).toContain("Anthropic");
    expect(html).toContain("OpenAI");
  });

  it("links the consent receipt endpoint and states the actual lifecycle", () => {
    const html = render();
    expect(html).toContain("GET /api/consent/ai/latest");
    expect(html).toContain("consent receipt");
    expect(html).toContain("cascade-deleted with the account");
    expect(html).not.toContain("receipts are retained for five years");
  });

  it("declares encryption in transit (TLS 1.3 + HSTS + cert pinning)", () => {
    const html = render();
    // SB-3 requirement 5.
    expect(html).toContain("TLS 1.3");
    expect(html).toContain("HSTS");
    // Cert pinning is described in two languages; both bodies mention
    // the practice but with different surrounding whitespace, so check
    // a tolerant regex.
    expect(html).toMatch(/certificate\s+pinning/i);
    expect(html).toMatch(/Zertifikat-Pinning/);
  });

  it("states the server location and operator framing", () => {
    const html = render();
    // SB-3 requirement 6: operated by an individual in Germany on
    // Hetzner; no third-party hosting except AI providers.
    expect(html).toContain("Germany");
    expect(html).toContain("Hetzner");
    expect(html).toContain("operator");
  });

  it("publishes retention behavior supported by server jobs", () => {
    const html = render();
    expect(html).toContain("server default: 365 days");
    expect(html).toContain("after 90 days");
    expect(html).toContain("No global five-year deletion job");
    expect(html).toContain("active bucket lifecycle rule");
  });

  it("discloses the current deletion route, MFA handoff, and cascade", () => {
    const html = render();
    expect(html).toContain("Settings → Account → Delete account");
    expect(html).toContain("MFA-enrolled account");
    expect(html).toContain("authenticated web account page");
    expect(html).toContain("local account-bound data");
    expect(html).toContain("Konto löschen");
    expect(html).toContain("Delete account");
    expect(html).toContain("User.delete");
    expect(html).toContain("onDelete: Cascade");
  });

  it("separates HealthLog storage from Apple-managed HealthKit sync", () => {
    const html = render();
    expect(html).toContain("No HealthLog iCloud storage");
    expect(html).toContain("offline outbox");
    expect(html).toContain("medication-reminder scheduler database");
    expect(html).toContain("excluded from device backup");
    expect(html).toContain("Apple-managed behaviour");
  });

  it("discloses every external AI topology and document operation", () => {
    const html = render();
    expect(html).toContain("Server-managed:");
    expect(html).toContain("Bring your own key (BYO):");
    expect(html).toContain("On device:");
    expect(html).toContain("Google Gemini");
    expect(html).toContain("generic OpenAI-compatible destination");
    expect(html).toContain("stored original image or PDF");
    expect(html).toContain("Per-document chat");
    expect(html).toContain("Settings → Assistant");
  });

  it("states the public heart-rate representation and excludes the experiment", () => {
    const html = render();
    expect(html).toContain("supported default heart-rate representation");
    expect(html).toContain("raw-heart-rate experiment is unavailable");
  });

  it("covers the linked App Store categories and declares no tracking", () => {
    const html = render();
    for (const category of [
      "Health &amp; Fitness",
      "Sensitive Info",
      "Name",
      "Contact Info",
      "User Content",
      "Photos or Videos",
      "Identifiers",
    ]) {
      expect(html).toContain(category);
    }
    expect(html).toContain("Tracking: No.");
    expect(html).toContain("no advertising");
    expect(html).toContain("third-party analytics SDK");
  });

  it("publishes the operator email + GitHub fallback channel", () => {
    const html = render();
    // SB-3 requirement 9: operator contact. The body uses the
    // "operator" framing per the v1.4.20 PII guidance — only the
    // email address attaches the actual contact.
    expect(html).toContain("mailto:mbombeck@gmail.com");
    expect(html).toContain("github.com/MBombeck/HealthLog/issues");
    // Project-voice rule: no personal name in user-facing artefacts.
    // The policy speaks in terms of "the operator" / "the controller",
    // never a person's full name. Only the bare email address attaches
    // the contact route. The regexes pin the operator's given-name /
    // surname fragments so a regression cannot reintroduce them.
    expect(html).not.toMatch(/Marc[- ]?Andr/i);
    expect(html).not.toMatch(/\bBombeck\s+[A-Z]/);
  });

  it("renders a discoverable footer with the version and license", () => {
    const html = render();
    expect(html).toContain('data-slot="privacy-footer"');
    expect(html).toContain("PolyForm Noncommercial License 1.0.0");
    expect(html).toContain(POLICY_VERSION);
  });
});
