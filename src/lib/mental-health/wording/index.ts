/**
 * Every questionnaire's wording in every app language.
 *
 * One file per instrument and language under this folder, each declaring
 * whether it reproduces a published validated translation (and which one) or
 * is a translation written for HealthLog. `wording-registry.test.ts` holds the
 * map complete: every instrument in every locale of `src/lib/i18n/config.ts`,
 * with the item count and the anchor values the scoring expects.
 *
 * A validated entry reproduces its source word for word: the stem, every
 * item, every answer and, for the PHQ-9, the follow-up question, in the form
 * of address the source uses. Left out are only the paper-form instructions
 * ("mark your answer with a cross") and the full stop that closes a printed
 * table cell; anything else an entry changes (a misprint, a stray character)
 * is named in its file. A published version is used only when its terms
 * allow reproducing it in software; a version whose text is behind a paywall
 * or under terms that allow private study only is named in the file of the
 * language it would have served, which then carries HealthLog's translation.
 *
 * Adding or replacing a language's wording is a change to the file here, with
 * the source in `source` and the PDF it was read from named in it. The app's
 * own copy around a questionnaire (titles, notes, buttons) stays in the
 * message bundles; the questionnaire itself never does.
 */
import type { Locale } from "@/lib/i18n/config";
import type { InstrumentId } from "../instruments";
import type { InstrumentWording } from "./types";

import phq9En from "./phq9/en";
import phq9De from "./phq9/de";
import phq9Es from "./phq9/es";
import phq9Fr from "./phq9/fr";
import phq9It from "./phq9/it";
import phq9Pl from "./phq9/pl";
import phq9Ko from "./phq9/ko";
import phq9Nl from "./phq9/nl";
import phq9PtBr from "./phq9/pt-br";
import gad7En from "./gad7/en";
import gad7De from "./gad7/de";
import gad7Es from "./gad7/es";
import gad7Fr from "./gad7/fr";
import gad7It from "./gad7/it";
import gad7Pl from "./gad7/pl";
import gad7Ko from "./gad7/ko";
import gad7Nl from "./gad7/nl";
import gad7PtBr from "./gad7/pt-br";
import who5En from "./who5/en";
import who5De from "./who5/de";
import who5Es from "./who5/es";
import who5Fr from "./who5/fr";
import who5It from "./who5/it";
import who5Pl from "./who5/pl";
import who5Ko from "./who5/ko";
import who5Nl from "./who5/nl";
import who5PtBr from "./who5/pt-br";
import sciEn from "./sci/en";
import sciDe from "./sci/de";
import sciEs from "./sci/es";
import sciFr from "./sci/fr";
import sciIt from "./sci/it";
import sciPl from "./sci/pl";
import sciKo from "./sci/ko";
import sciNl from "./sci/nl";
import sciPtBr from "./sci/pt-br";

export const WORDING: Readonly<
  Record<InstrumentId, Readonly<Record<Locale, InstrumentWording>>>
> = {
  PHQ9: {
    en: phq9En,
    de: phq9De,
    es: phq9Es,
    fr: phq9Fr,
    it: phq9It,
    pl: phq9Pl,
    ko: phq9Ko,
    nl: phq9Nl,
    "pt-BR": phq9PtBr,
  },
  GAD7: {
    en: gad7En,
    de: gad7De,
    es: gad7Es,
    fr: gad7Fr,
    it: gad7It,
    pl: gad7Pl,
    ko: gad7Ko,
    nl: gad7Nl,
    "pt-BR": gad7PtBr,
  },
  WHO5: {
    en: who5En,
    de: who5De,
    es: who5Es,
    fr: who5Fr,
    it: who5It,
    pl: who5Pl,
    ko: who5Ko,
    nl: who5Nl,
    "pt-BR": who5PtBr,
  },
  SCI: {
    en: sciEn,
    de: sciDe,
    es: sciEs,
    fr: sciFr,
    it: sciIt,
    pl: sciPl,
    ko: sciKo,
    nl: sciNl,
    "pt-BR": sciPtBr,
  },
};
