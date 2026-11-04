/**
 * Output-language resolution for the assessment prompt family.
 *
 * The problem this solves: the prompt modules historically branched
 * `locale === "en" ? EN_BODY : DE_BODY`. That binary is correct for a de/en
 * product, but HealthLog ships six UI locales — so every fr/es/it/pl reader
 * fell to the GERMAN instruction body, whose output clause explicitly asks for
 * a German assessment. A French account therefore received German prose (on
 * the surfaces that reached the prompts at all).
 *
 * The fix keeps ONE instruction body per prompt in the two languages that have
 * a reviewed body (de, en) and names the reader's language in an explicit
 * directive, rather than growing four more hand-maintained translations of
 * every prompt. The directive text itself is NOT invented here: it is the
 * `reply_language_directive` from `safety-contracts.<locale>.yaml`, written
 * natively per locale and already carried in production by the native
 * insights/briefing prompts (`native-prompts.ts:338,507`). This module only
 * makes that same mechanism reachable from the assessment family.
 *
 * Polarity matters and is the whole point: the fallback for an unknown or
 * non-German locale is ENGLISH, never German. `instructionLocale` is the
 * single replacement for every scattered de-default binary.
 */
import type { Locale } from "@/lib/i18n/config";

import { loadSafetyContracts } from "./safety-contracts";

/**
 * Which reviewed instruction body a locale composes.
 *
 * German for German readers (its body is reviewed and its register is the one
 * the largest non-English audience reads); English for everyone else. The
 * reader's actual language is then named by `outputLanguageDirective`.
 */
export function instructionLocale(locale: Locale): "de" | "en" {
  return locale === "de" ? "de" : "en";
}

/**
 * English name of the language the assessment must be WRITTEN in.
 *
 * English names because they are interpolated into the English instruction
 * body; the directive that follows is in the reader's own language.
 */
export function targetLanguageName(locale: Locale): string {
  switch (locale) {
    case "de":
      return "German";
    case "fr":
      return "French";
    case "es":
      return "Spanish";
    case "it":
      return "Italian";
    case "pl":
      return "Polish";
    case "ko":
      return "Korean";
    case "nl":
      return "Dutch";
    case "pt-BR":
      return "Brazilian Portuguese";
    case "ru":
      return "Russian";
    default:
      return "English";
  }
}

/**
 * Fallback directive when the safety matrix cannot be loaded.
 *
 * The matrix read is a synchronous file read + schema parse that throws on a
 * malformed or missing file. A prompt that silently loses its language
 * directive would regress exactly the bug this module fixes, so fall back to a
 * plain English instruction naming the language rather than to an empty
 * string.
 */
function fallbackDirective(locale: Locale): string {
  return `Write your reply in ${targetLanguageName(locale)}.`;
}

/**
 * The terminal OUTPUT LANGUAGE section for a prompt, or `""` when the
 * composed instruction body already carries the language natively.
 *
 * de and en compose their own reviewed body, whose output clause already names
 * the language — appending a directive there would be redundant and would
 * change two prompts that are deliberately byte-stable. The four locales that
 * ride the English body get the directive, placed last so it is the most
 * recent instruction the model reads.
 */
export function outputLanguageDirective(locale: Locale): string {
  if (locale === "de" || locale === "en") return "";

  let directive: string;
  try {
    directive = loadSafetyContracts(locale).reply_language_directive;
  } catch {
    directive = fallbackDirective(locale);
  }

  return `OUTPUT LANGUAGE: ${directive}`;
}

/**
 * Append the directive to a composed prompt when one applies.
 *
 * Kept here so every adopting module joins it identically (blank-line
 * separated, directive last) instead of each re-deriving the spacing.
 */
export function withOutputLanguage(prompt: string, locale: Locale): string {
  const directive = outputLanguageDirective(locale);
  return directive ? `${prompt}\n\n${directive}` : prompt;
}
