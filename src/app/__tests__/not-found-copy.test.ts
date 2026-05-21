/**
 * v1.4.43 QoL (L1) — pin the tightened 404 / global-error copy so a
 * future translator does not re-introduce the v1.4.27 marketing
 * paragraph. The 404 page now ships with i18n keys (`notFound.*`)
 * across all six locales; the global-error boundary remains static
 * bilingual (no i18n provider available at that level).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");
const LOCALES = ["en", "de", "fr", "es", "it", "pl"] as const;

interface Messages {
  notFound: {
    title: string;
    backToDashboard: string;
  };
}

function load(locale: string): Messages {
  const raw = readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8");
  return JSON.parse(raw) as Messages;
}

describe("notFound copy", () => {
  it.each(LOCALES)("%s: ships title + backToDashboard keys", (locale) => {
    const messages = load(locale);
    expect(messages.notFound.title.trim().length).toBeGreaterThan(0);
    expect(messages.notFound.backToDashboard.trim().length).toBeGreaterThan(0);
  });

  it.each(LOCALES)(
    "%s: title is tight — under 60 characters, ends with a period",
    (locale) => {
      const messages = load(locale);
      // Tightened copy is a single short statement, e.g. "Diese Seite
      // existiert nicht." The 60-char ceiling pins out a future return
      // of the verbose marketing block.
      expect(messages.notFound.title.length).toBeLessThanOrEqual(60);
      expect(messages.notFound.title).toMatch(/\.$/);
    },
  );

  it("de: matches the tightened copy exactly", () => {
    const messages = load("de");
    expect(messages.notFound.title).toBe("Diese Seite existiert nicht.");
  });

  it("en: matches the tightened copy exactly", () => {
    const messages = load("en");
    expect(messages.notFound.title).toBe("This page doesn't exist.");
  });
});

describe("global-error bilingual copy", () => {
  // The global-error boundary cannot reach the i18n provider (root
  // layout has failed). The v1.4.43 audit asked for a bilingual
  // lockup so a German user does not read pure English in a bad-
  // state moment. Read the file and assert both languages appear.
  const globalErrorPath = join(ROOT, "src/app/global-error.tsx");
  const source = readFileSync(globalErrorPath, "utf8");

  it("ships the German leading phrase next to the English fallback", () => {
    expect(source).toContain("Etwas ist schiefgegangen");
    expect(source).toContain("Something went wrong");
  });

  it("ships the German error subtitle next to the English fallback", () => {
    expect(source).toContain("Ein kritischer Fehler ist aufgetreten");
    // The JSX-formatter wraps the English fallback across two lines, so
    // collapse all whitespace before searching.
    const collapsed = source.replace(/\s+/g, " ");
    expect(collapsed).toContain("A critical error occurred");
  });
});
