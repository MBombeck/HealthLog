/**
 * Reachability note. This module was written for `generateInsight()`, whose
 * only caller was `runWithFallback()` — and that had no production caller,
 * because every live surface routes through `runRawCompletionWithFallback`.
 * The coverage annotation therefore never executed: an audit surface that
 * implied enforcement it did not perform.
 *
 * v1.30.24 kept the logic and widened the input type to the structural shape
 * both payloads share, so the comprehensive post-parse step could call it and
 * the admin quality dashboard could see real data. The dead wrapper and chain
 * runner around it have since been removed outright, so this module now has
 * exactly one caller and it is a live one.
 *
 * Observational by design: an uncited normative recommendation is an
 * annotation, never a parse failure. It is a METRIC, not a gate — the citation
 * ENFORCEMENT that once sat beside it is gone rather than dormant, so nothing
 * here should be read as withholding output.
 */

/**
 * The minimum recommendation shape the coverage check needs. Both the strict
 * `AIInsightResponse` and the live `InsightResult` satisfy it; the live union
 * also admits a bare string, which carries neither an id nor a citation and is
 * therefore counted as uncited when it makes a normative claim.
 */
export interface RecommendationForCoverage {
  id?: string;
  text: string;
  referenceId?: string;
  /**
   * Callers pass their own richer recommendation objects (severity, rationale,
   * metricSource, …). Only the three fields above are read; the index
   * signature keeps a wider literal assignable without a cast at every site.
   */
  [key: string]: unknown;
}

export interface PayloadForCoverage {
  recommendations: ReadonlyArray<RecommendationForCoverage | string>;
  /** Callers pass the whole payload; only `recommendations` is read. */
  [key: string]: unknown;
}

/**
 * v1.4.16 — citation-coverage post-validation.
 *
 * After the schema parse + cross-citation check pass, the wrapper
 * counts how many recommendations make a normative claim
 * ("target", "should", "normal range", "above", "below") and how
 * many of those carry a `referenceId` pointing into the curated
 * medical-reference bundle. The result lands as a Wide-Event meta
 * annotation so the admin AI quality dashboard can track coverage
 * over time.
 *
 * The check is observational only — a normative rec without a
 * referenceId is logged as a warning, never raised as a parse
 * failure. v1.4.16 phase B5c flips it to required for severity
 * >= "important".
 *
 * ## Why the keyword bank has six arms
 *
 * The recommendations are generated in the READER's language — the prompt is
 * built per locale and `screenInsightPayloadProse` screens the same prose
 * against the same locale. The bank was English plus German, so for a French,
 * Spanish, Italian or Polish reader every recommendation scored
 * non-normative: the annotation reported `normative: 0`, `uncited: 0`, and the
 * admin dashboard read that as perfect coverage rather than as no measurement
 * at all. A check that cannot fail is worse than no check, because it is
 * indistinguishable from a passing one.
 *
 * These words are NOT in `messages/*.json` — they are the model's own prose,
 * not app labels — so the derive-from-the-bundles shape that fits a UI label
 * does not apply here. The bank is hand-written, and the structural test
 * refuses to let a locale ship with an empty arm: adding a seventh language
 * fails the suite instead of silently reporting 0/0 for it.
 *
 * Matching policy: fold both sides through `foldForMatch` (case, accents,
 * hyphens, apostrophes) and require a LEADING word boundary while leaving the
 * tail free, so the LLM's inflections still hit ("targets", "should be",
 * "objectifs") without "sopra" firing inside the everyday Italian
 * "soprattutto".
 */

import { locales, type Locale } from "@/lib/i18n/config";
import { foldForMatch } from "@/lib/i18n/fold-for-match";

/**
 * Normative-claim vocabulary per shipped locale, in `foldForMatch` normal form
 * (lower case, no accents, hyphens and apostrophes as spaces). Stems, not whole
 * words: the leading-boundary matcher leaves the tail free.
 *
 * Comparatives are spelled as the phrase the language actually uses — "au
 * dessus", "por encima", "al di sopra" — rather than the bare preposition,
 * which in Italian and Spanish rides inside common unrelated words.
 *
 * Polish "ł" survives the fold (NFD has no decomposition for it), so the
 * entries are written the way a Polish reply spells them.
 */
const NORMATIVE_KEYWORDS: Record<Locale, readonly string[]> = {
  en: ["target", "should", "normal range", "above", "below"],
  de: ["ziel", "sollte", "normalbereich", "uber", "unter"],
  fr: [
    "objectif",
    "cible",
    "devrait",
    "devriez",
    "plage normale",
    "au dessus",
    "au dessous",
    "en dessous",
    "superieur",
    "inferieur",
  ],
  es: [
    "objetivo",
    "deberia",
    "rango normal",
    "por encima",
    "por debajo",
    "superior",
    "inferior",
  ],
  it: [
    "obiettivo",
    "dovrebbe",
    "dovresti",
    "intervallo normale",
    "al di sopra",
    "al di sotto",
    "superiore",
    "inferiore",
  ],
  pl: [
    "cel",
    "docelow",
    "powinien",
    "powinna",
    "powinno",
    "powinny",
    "zakres normy",
    "powyzej",
    "ponizej",
  ],
  nl: [
    "doel",
    "streefwaarde",
    "zou moeten",
    "hoort",
    "normaalwaarde",
    "normaal bereik",
    "boven de",
    "onder de",
  ],
  ko: [
    "목표",
    "권장",
    "정상 범위",
    "해야",
    "하세요",
    "이상",
    "이하",
    "초과",
    "미만",
  ],
  // "meta" alone would also open "metabolismo" and "metade", so the goal noun
  // is spelled with its preposition.
  "pt-BR": [
    "meta de",
    "metas de",
    "alvo",
    "objetivo",
    "deveria",
    "deve ser",
    "devem ser",
    "faixa normal",
    "acima d",
    "abaixo d",
    "superior a",
    "inferior a",
  ],
  // Russian replies state a target or a reference interval; the stems carry
  // the case endings (целевой/целевого, референсный/референсного), and "выше"/
  // "ниже" are the comparatives a recommendation actually uses. ё folds to е.
  ru: [
    "целев",
    "цель",
    "должн",
    "следует",
    "рекоменд",
    "нормальн",
    "норма",
    "референс",
    "выше",
    "ниже",
    "больше",
    "меньше",
    "в пределах",
  ],
};

/**
 * One compiled matcher per locale — leading word boundary, free tail.
 *
 * An EMPTY bank compiles to a matcher that never fires, not to `(?:)`, which
 * matches the empty string at offset 0 and would therefore grade every
 * recommendation normative. The failure modes of a missing bank point in
 * opposite directions — silently zero before, silently total after — and both
 * are unreadable on the dashboard, so the structural test forbids the empty
 * bank outright and this only keeps the fallback honest.
 */
const NEVER_MATCHES = /(?!)/u;

const NORMATIVE_MATCHERS: Record<Locale, RegExp> = Object.fromEntries(
  locales.map((locale) => {
    const bank = NORMATIVE_KEYWORDS[locale];
    if (bank.length === 0) return [locale, NEVER_MATCHES];
    const alternation = bank
      .map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    return [locale, new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})`, "u")];
  }),
) as Record<Locale, RegExp>;

/**
 * Test seam: the guard suite asserts every shipped locale carries a non-empty
 * bank, so a new language cannot land silently scoring every recommendation
 * non-normative.
 */
export function normativeKeywordBank(): Record<Locale, readonly string[]> {
  return NORMATIVE_KEYWORDS;
}

/**
 * Returns true when the rec text contains a normative-claim keyword.
 *
 * The READER's bank and the English one both run. English is always included
 * because a fallback provider (or a model that ignores the language directive)
 * answers a non-English reader in English — the same dual-bank rule the Coach's
 * reference-sentence exemption uses.
 */
export function detectsNormativeClaim(
  text: string,
  locale: Locale = "en",
): boolean {
  const folded = foldForMatch(text);
  if (folded === "") return false;
  if (NORMATIVE_MATCHERS[locale].test(folded)) return true;
  return locale !== "en" && NORMATIVE_MATCHERS.en.test(folded);
}

export interface CitationCoverage {
  /** Total `recommendations[]` length. */
  totalRecommendations: number;
  /** Subset of recs that make a normative claim. */
  normativeRecommendations: number;
  /** Subset of normative recs that carry a `referenceId`. */
  citedNormativeRecommendations: number;
  /** Recommendation ids that are normative but lack a referenceId. */
  uncitedNormativeRecommendationIds: string[];
}

/**
 * Compute the citation-coverage breakdown for a parsed insight
 * response. Pure function — no side effects, safe to unit test in
 * isolation. The comprehensive generator calls this once on the successful
 * parse and forwards the result via `annotate()`.
 *
 * `locale` is the language the recommendations were GENERATED in, not a
 * display preference: it selects which normative-claim bank grades them.
 */
export function computeCitationCoverage(
  parsed: PayloadForCoverage,
  locale: Locale = "en",
): CitationCoverage {
  const total = parsed.recommendations.length;
  let normative = 0;
  let cited = 0;
  const uncitedIds: string[] = [];

  for (const [index, raw] of parsed.recommendations.entries()) {
    const rec: RecommendationForCoverage =
      typeof raw === "string" ? { text: raw } : raw;
    if (!detectsNormativeClaim(rec.text, locale)) continue;
    normative += 1;
    if (rec.referenceId) {
      cited += 1;
    } else {
      // A legacy string rec has no id of its own; index it so the dashboard
      // can still point at which entry was uncited.
      uncitedIds.push(rec.id ?? `index:${index}`);
    }
  }

  return {
    totalRecommendations: total,
    normativeRecommendations: normative,
    citedNormativeRecommendations: cited,
    uncitedNormativeRecommendationIds: uncitedIds,
  };
}
