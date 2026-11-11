import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveKey } from "@/lib/i18n/resolve-key";

/**
 * The illness screens name the vital that drives a recovery gap and label the
 * day picker of the log sheet through these keys. They were once copied from
 * English into five catalogs, so a German reader saw "Weight", "Pulse",
 * "Recovery" and "Day" among translated neighbours. The English leak guard
 * skips single words, so it cannot see this; the pin below can.
 */
const MESSAGES_DIR = join(__dirname, "../../../../messages");

function catalog(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

const KEYS = [
  "illness.vital.WEIGHT",
  "illness.vital.PULSE",
  "illness.vital.RECOVERY_SCORE",
  "illness.sheet.day",
] as const;

const english = catalog("en");

describe("illness labels", () => {
  for (const locale of [
    "de",
    "fr",
    "es",
    "it",
    "pl",
    "nl",
    "pt-BR",
    "ko",
    "ru",
  ]) {
    it(`are translated in ${locale}`, () => {
      const messages = catalog(locale);
      for (const key of KEYS) {
        const value = resolveKey(messages, key);
        expect(value, `${locale} ${key}`).toBeTruthy();
        expect(value, `${locale} ${key} is still English`).not.toBe(
          resolveKey(english, key),
        );
      }
    });
  }
});
