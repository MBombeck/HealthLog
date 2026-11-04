/**
 * Population-norm framing per locale, one module per language. A sentence
 * that matches is read as population guidance, and its numbers are exempt
 * from the evidence check (`../coach-prose-grounding.ts`, rung 2), so every
 * entry needs a population subject or a reference noun.
 */
import type { Locale } from "@/lib/i18n/config";

import { patterns as en } from "./en";
import { patterns as de } from "./de";
import { patterns as fr } from "./fr";
import { patterns as es } from "./es";
import { patterns as it } from "./it";
import { patterns as pl } from "./pl";
import { patterns as nl } from "./nl";
import { patterns as ptBR } from "./pt-br";
import { patterns as ko } from "./ko";
import { patterns as ru } from "./ru";

export const POPULATION_NORM_PATTERNS: Readonly<
  Record<Locale, readonly RegExp[]>
> = {
  en,
  de,
  fr,
  es,
  it,
  pl,
  nl,
  "pt-BR": ptBR,
  ko,
  ru,
};
