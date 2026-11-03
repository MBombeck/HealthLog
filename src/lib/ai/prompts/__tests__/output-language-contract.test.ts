import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import { getBaseSystemPrompt } from "@/lib/ai/prompts/base-system";
import {
  instructionLocale,
  outputLanguageDirective,
  targetLanguageName,
  withOutputLanguage,
} from "@/lib/ai/prompts/output-language";
import { loadSafetyContracts } from "@/lib/ai/prompts/safety-contracts";

/**
 * The output-language contract.
 *
 * These tests exist because four of the six locales cannot be eyeballed at
 * review time. They pin the mechanical guarantees — which body a locale
 * composes, that its own language is named, that the locale's own directive is
 * present and last, and that no German leaks into a non-German prompt.
 *
 * What they deliberately do NOT claim: that the model's prose is idiomatic or
 * correct in French, Spanish, Italian or Polish. No offline test can show
 * that. The precedent is the native insights/briefing prompts, which have
 * carried the same directive in production, and the residual risk is covered
 * by a production check, not by this file.
 */

/**
 * A word that appears in the German instruction body and in no English one.
 * If it shows up in a non-German prompt, the de-default collapse is back.
 */
const GERMAN_SENTINEL = /AUSGABEFORMAT|Antworte ausschließlich|Einschätzung/;

/** English names, written literally — never derived from the module under test. */
const EXPECTED_LANGUAGE_NAME: Record<Locale, string> = {
  de: "German",
  en: "English",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pl: "Polish",
  nl: "Dutch",
  ko: "Korean",
  "pt-BR": "Brazilian Portuguese",
  ru: "Russian",
};

/** Which body each locale is expected to compose. */
const EXPECTED_BODY: Record<Locale, "de" | "en"> = {
  de: "de",
  en: "en",
  fr: "en",
  es: "en",
  it: "en",
  pl: "en",
  nl: "en",
  ko: "en",
  "pt-BR": "en",
  ru: "en",
};

describe("output-language helper", () => {
  it("routes only German to the German body — every other locale to English", () => {
    for (const locale of locales) {
      expect(instructionLocale(locale), `instruction body for ${locale}`).toBe(
        EXPECTED_BODY[locale],
      );
    }
  });

  it("names each locale's language", () => {
    for (const locale of locales) {
      expect(targetLanguageName(locale)).toBe(EXPECTED_LANGUAGE_NAME[locale]);
    }
  });

  it("emits the locale's OWN directive for the four riding the English body", () => {
    for (const locale of ["fr", "es", "it", "pl"] as const) {
      const directive = outputLanguageDirective(locale);
      expect(directive, `directive for ${locale}`).toContain(
        "OUTPUT LANGUAGE:",
      );
      // The directive text must be the locale's own translated clause, not a
      // generic English one — that is what makes it authoritative to the model.
      expect(directive).toContain(
        loadSafetyContracts(locale).reply_language_directive,
      );
    }
  });

  it("emits no directive for de/en (their bodies name the language natively)", () => {
    expect(outputLanguageDirective("de")).toBe("");
    expect(outputLanguageDirective("en")).toBe("");
  });

  it("appends the directive last, blank-line separated", () => {
    const composed = withOutputLanguage("BODY", "fr");
    expect(composed.startsWith("BODY\n\n")).toBe(true);
    expect(
      composed.endsWith(loadSafetyContracts("fr").reply_language_directive),
    ).toBe(true);
  });

  it("leaves a de/en prompt untouched", () => {
    expect(withOutputLanguage("BODY", "de")).toBe("BODY");
    expect(withOutputLanguage("BODY", "en")).toBe("BODY");
  });
});

describe("base system prompt — every locale", () => {
  it("asks for the assessment in the reader's own language", () => {
    for (const locale of locales) {
      const prompt = getBaseSystemPrompt(locale);
      if (locale === "de") {
        // The German body states its language in German.
        expect(prompt).toContain("auf Deutsch");
      } else {
        expect(
          prompt,
          `${locale} must name its own language in the output clause`,
        ).toContain(`complete assessment in ${EXPECTED_LANGUAGE_NAME[locale]}`);
      }
    }
  });

  it("never sends German instructions to a non-German locale", () => {
    // This is the regression the whole change exists to prevent.
    for (const locale of locales) {
      if (locale === "de") continue;
      expect(
        GERMAN_SENTINEL.test(getBaseSystemPrompt(locale)),
        `${locale} prompt contains German instruction text`,
      ).toBe(false);
    }
  });

  it("ends the four non-de/en prompts with their own directive", () => {
    for (const locale of ["fr", "es", "it", "pl"] as const) {
      // `[\s\S]` rather than `.` + the `s` flag — the compile target predates
      // dotAll, and the directive can span lines.
      expect(getBaseSystemPrompt(locale).trimEnd()).toMatch(
        /OUTPUT LANGUAGE: [\s\S]+$/,
      );
    }
  });

  it("produces a distinct prompt per locale (no silent collapse)", () => {
    const seen = new Map<string, Locale>();
    for (const locale of locales) {
      const prompt = getBaseSystemPrompt(locale);
      const clash = seen.get(prompt);
      expect(
        clash,
        `${locale} produced a prompt identical to ${clash} — a locale collapsed`,
      ).toBeUndefined();
      seen.set(prompt, locale);
    }
  });
});
