/**
 * The questionnaire text as the server and the tests read it: every language
 * at once, and the one answer to which wording an administration was given
 * in. A client surface loads one language through `./load.ts` instead.
 */
import { localeFromLanguageTag } from "@/lib/i18n/config";

import type { InstrumentId } from "../instruments";
import { wordingLocale } from "../instrument-wording";
import { WORDING } from "./index";
import type { AssessmentWording, InstrumentWording } from "./types";

/**
 * The instrument's text for a reader of `locale`. A language the app does
 * not ship reads the English original.
 */
export function wordingFor(
  id: InstrumentId,
  locale: string,
): InstrumentWording {
  return WORDING[id][wordingLocale(locale)];
}

/** Whether the text for `locale` is a published validated translation. */
export function isValidatedWording(id: InstrumentId, locale: string): boolean {
  return wordingFor(id, locale).validated;
}

/**
 * The wording an administration was answered in, from what the reader saw:
 * their language's text, or the English original they switched to.
 */
export function presentedWording(
  id: InstrumentId,
  locale: string,
  englishOriginal: boolean,
): AssessmentWording {
  const resolved = localeFromLanguageTag(locale);
  if (resolved === "en") return "validated";
  if (englishOriginal || resolved === null) return "original_en";
  return WORDING[id][resolved].validated
    ? "validated"
    : "unvalidated_translation";
}
