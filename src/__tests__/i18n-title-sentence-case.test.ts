import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Titles are written in sentence case.
 *
 * Page titles, card titles and headings capitalise their first word and
 * proper names only: "Blood pressure", not "Blood Pressure". The rail, the
 * tab strip and the glossary already wrote it that way, while thirty-odd
 * Insights page titles stood in Title Case, so one page could show both
 * spellings stacked on top of each other.
 *
 * The guard reads every key whose last segment ends in `title` or `heading`
 * (`title`, `subtitle`, `emptyTitle`, `sectionHeading`, …) in the bundles
 * whose language writes headings in sentence case, and fails on a capital
 * letter at the start of any word after the first of a sentence, unless the
 * word is a product or brand name (`PROPER_NAMES`), an acronym (`BMI`), or
 * carries an inner capital (`HealthLog`, `iPhone`). German capitalises nouns
 * and Polish capitalises the polite pronoun, so those two are not read; nor
 * are the scripts without letter case in the Title Case sense (ko) and
 * Russian, which writes product names in Cyrillic.
 *
 * A word that is a name in one language only, or a quoted page name, goes
 * into `ALLOWED_WORDS` for that language with the reason beside it.
 */

const MESSAGES_DIR = join(__dirname, "../../messages");

const LOCALES = ["en", "es", "fr", "it", "nl", "pt-BR"] as const;

/** Product, feature and brand names that keep their capital everywhere. */
const PROPER_NAMES = new Set([
  "Coach",
  "Insights",
  "Apple",
  "Health",
  "Wallet",
  "Connect",
  "Google",
  "Withings",
  "Nightscout",
  "Polar",
  "Oura",
  "Strava",
  "Dawarich",
  "Garmin",
  "Fitbit",
  "Gadgetbridge",
  "Umami",
  // "Web Push", the standard's name.
  "Web",
  "Push",
  "Bearer",
]);

const ALLOWED_WORDS: Partial<Record<(typeof LOCALES)[number], Set<string>>> = {
  // "Apple Santé" / "Apple Salute": Apple's own name for the app there.
  fr: new Set(["Santé", "Supprimés"]),
  it: new Set(["Salute", "Eliminati"]),
  // The trash page's own name, quoted in its empty state.
  en: new Set(["Recently"]),
  es: new Set(["Eliminados"]),
  "pt-BR": new Set(["Excluídos"]),
  nl: new Set(["Recent"]),
};

const TITLE_KEY = /(title|Title|heading|Heading)$/;
const SENTENCE_BREAK = /[.?!:]\s+|\s[-–—]\s|[()«»"“”'‘’]/u;
const WORD = /[\p{L}][\p{L}\p{N}'’-]*/gu;

function flatten(
  obj: unknown,
  prefix: string,
  out: Map<string, string>,
): Map<string, string> {
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else if (typeof v === "object") flatten(v, key, out);
  }
  return out;
}

function titleCaseWords(value: string, allowed: Set<string>): string[] {
  // ICU arguments and plural arms are not prose.
  const prose = value.replace(/\{[^{}]*\}/g, " ");
  const found: string[] = [];
  for (const sentence of prose.split(SENTENCE_BREAK)) {
    const words = sentence.match(WORD) ?? [];
    for (const word of words.slice(1)) {
      const first = word[0];
      if (first === first.toLowerCase()) continue;
      if (word === word.toUpperCase()) continue;
      if (/\p{Lu}/u.test(word.slice(1))) continue;
      const bare = word.split(/[-’']/)[0];
      if (PROPER_NAMES.has(bare) || allowed.has(bare)) continue;
      found.push(word);
    }
  }
  return found;
}

describe("titles are in sentence case", () => {
  it.each(LOCALES)("%s", (locale) => {
    const bundle = JSON.parse(
      readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8"),
    );
    const entries = [...flatten(bundle, "", new Map())].filter(([key]) =>
      TITLE_KEY.test(key.split(".").at(-1) ?? ""),
    );
    // A matcher that finds no title key would pass on nothing.
    expect(entries.length).toBeGreaterThan(500);
    const allowed = ALLOWED_WORDS[locale] ?? new Set<string>();
    const offenders = entries
      .map(([key, value]) => ({ key, words: titleCaseWords(value, allowed) }))
      .filter((e) => e.words.length > 0)
      .map((e) => `${e.key}: ${e.words.join(", ")}`);
    expect(offenders).toEqual([]);
  });

  it("catches Title Case", () => {
    expect(titleCaseWords("Blood Pressure", new Set())).toEqual(["Pressure"]);
    expect(titleCaseWords("Disconnect Withings?", new Set())).toEqual([]);
    expect(titleCaseWords("Body mass index (BMI)", new Set())).toEqual([]);
    expect(titleCaseWords("About HealthLog", new Set())).toEqual([]);
  });

  it("allows only words that are still used", () => {
    const stale: string[] = [];
    for (const [locale, words] of Object.entries(ALLOWED_WORDS)) {
      const raw = readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8");
      for (const word of words ?? []) {
        if (!raw.includes(word)) stale.push(`${locale}: ${word}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
