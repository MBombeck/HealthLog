import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { resolveKey } from "@/lib/i18n/resolve-key";

/**
 * The Vorsorge reminder type labels + the document bulk-share copy resolve
 * through DYNAMIC keys (`t(\`measurementReminders.types.${type}\`)`), which the
 * static i18n call-site coverage guard cannot see. This test asserts the
 * dynamic keys exist and resolve to a non-empty string in EVERY locale bundle —
 * the guard that would have caught the missing WHO5_SCORE / SCI_SCORE labels
 * (which rendered as the raw key prefix "measurementReminders.types.…").
 */
const MESSAGES_DIR = join(__dirname, "../../../../messages");

const LOCALES = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    locale: f.replace(/\.json$/, ""),
    messages: JSON.parse(readFileSync(join(MESSAGES_DIR, f), "utf8")) as Record<
      string,
      unknown
    >,
  }));

// The keys that MUST resolve in every locale (dynamic-key floor).
const REQUIRED_KEYS = [
  // Newly added Vorsorge reminder type labels.
  "measurementReminders.types.WAIST_CIRCUMFERENCE",
  "measurementReminders.types.WHO5_SCORE",
  "measurementReminders.types.SCI_SCORE",
  // Pre-existing screening labels (regression floor).
  "measurementReminders.types.PHQ9_SCORE",
  "measurementReminders.types.GAD7_SCORE",
  // Bulk-share copy.
  "documents.bulk.share",
  "documents.bulk.shareTooMany",
  "documents.share.multiTitle",
  "documents.share.multiLabel",
];

describe("measurement-reminder + bulk-share dynamic i18n keys", () => {
  it("discovers all ten shipped locales", () => {
    expect(LOCALES.map((l) => l.locale).sort()).toEqual([
      "de",
      "en",
      "es",
      "fr",
      "it",
      "ko",
      "nl",
      "pl",
      "pt-BR",
      "ru",
    ]);
  });

  for (const { locale, messages } of LOCALES) {
    for (const key of REQUIRED_KEYS) {
      it(`resolves ${key} in ${locale}`, () => {
        const value = resolveKey(messages, key);
        expect(value, `${key} missing in ${locale}.json`).toBeTypeOf("string");
        expect((value ?? "").trim().length).toBeGreaterThan(0);
      });
    }
  }
});
