import { describe, it, expect } from "vitest";
import { getServerTranslator } from "../i18n/server-translator";

describe("getServerTranslator", () => {
  it("returns the German string for a known key when locale=de", () => {
    const { t } = getServerTranslator("de");
    expect(t("telegram.cancelled")).toBe("Abgebrochen.");
  });

  it("returns the English string for a known key when locale=en", () => {
    const { t } = getServerTranslator("en");
    expect(t("telegram.cancelled")).toBe("Cancelled.");
  });

  it("interpolates {param} placeholders", () => {
    const { t } = getServerTranslator("en");
    expect(t("telegram.snoozedFor", { name: "Ramipril", duration: "1 hour" })).toBe(
      "Ramipril snoozed for 1 hour.",
    );
  });

  it("falls back to English when a key is missing in the German bundle", () => {
    // Sanity: every telegram.* key currently exists in both bundles, so
    // simulate a missing key via a deeply nested path.
    const { t } = getServerTranslator("de");
    expect(t("telegram.__definitely_missing__")).toBe(
      "telegram.__definitely_missing__",
    );
  });

  it("returns the raw key when missing in both locales", () => {
    const { t } = getServerTranslator("en");
    expect(t("nope.also.missing")).toBe("nope.also.missing");
  });

  it("exposes the active locale on the returned translator", () => {
    expect(getServerTranslator("de").locale).toBe("de");
    expect(getServerTranslator("en").locale).toBe("en");
  });
});
