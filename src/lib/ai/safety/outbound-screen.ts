/**
 * Unified outbound safety screen for every model-generated text the app
 * shows or stores.
 *
 * Background — what this replaces. The Coach had an outbound screen
 * (`screenCoachReply`) and nothing else did. A dose-change imperative or a
 * fabricated clinical risk score written into a per-metric status card, a
 * document summary, or the daily briefing reached the user unfiltered, while
 * the byte-identical sentence in the Coach was caught and replaced. The
 * per-surface grounding gates that DO exist grade different things: the
 * briefing gate grades NUMBERS only (and only `paragraph` / `signalsOfDay` /
 * `keyFindings`), and the causal-claim ban of GROUND RULE 12 was enforced in
 * code on exactly one surface — the period narrative. This module is the one
 * screen every model-output boundary runs, so the contracts are enforced
 * rather than merely composed into a prompt.
 *
 * Why locale is a required argument. The old signature was
 * `screenCoachReply(reply: string)` — it could not be locale-aware by
 * construction, so its banks were EN + DE stems and the dose-refusal /
 * risk-score contracts had no enforcement at all for fr / es / it / pl even
 * though the ground rules ship in all six `safety-contracts.*.yaml` files. A
 * guard that cannot see the language cannot enforce a language-specific
 * contract. Locale is now threaded from the caller's resolved reader locale.
 *
 * Why the reader's bank AND the EN bank always run. The provider is free-form
 * prose over a wire we do not control; a model answering a French reader
 * routinely emits English (a fallback model, a truncated system prompt, a
 * provider that ignores the language directive). Screening only the reader's
 * locale would let the proven EN violation shapes through on five of six
 * locales. The union costs one extra pass over a short string.
 *
 * Why patterns and not an LLM judge: deterministic, cheap, auditable, and not
 * itself promptable — the same posture as the inbound `detectRefusal`.
 *
 * Posture on false positives. The dose bank requires a CHANGE verb plus a
 * target dose with a unit, so a factual restatement the contracts explicitly
 * permit ("you're on 7.5 mg this week") does not trip — only an imperative to
 * change does. The causal bank is deliberately NOT applied to the Coach:
 * conversational prose uses "because" constantly and GROUND RULE 12's declared
 * surface is `insights`. Callers name the contracts they want; there is no
 * "screen everything" default that would silently widen a surface's contract.
 */
import { locales, type Locale } from "@/lib/i18n/config";

import { bank as en } from "./outbound-screen/locales/en";
import { bank as de } from "./outbound-screen/locales/de";
import { bank as fr } from "./outbound-screen/locales/fr";
import { bank as es } from "./outbound-screen/locales/es";
import { bank as it } from "./outbound-screen/locales/it";
import { bank as pl } from "./outbound-screen/locales/pl";
import { bank as nl } from "./outbound-screen/locales/nl";
import { bank as ko } from "./outbound-screen/locales/ko";
import { bank as ptBR } from "./outbound-screen/locales/pt-br";
import { bank as ru } from "./outbound-screen/locales/ru";
import {
  DOSE_UNIT,
  INN_STEM,
  LETTER,
  UNIT_END,
  type LocaleBank,
} from "./outbound-screen/shared";
import type { ScheduledDose } from "@/lib/medications/scheduled-doses";

/** Which contract a caller asks the screen to enforce. */
export type OutboundContract = "dose" | "risk" | "causal";

/** Why the text was blocked, for the Wide-Event annotation. */
export type OutboundReason =
  "dose_prescription" | "risk_score" | "causal_claim";

export interface OutboundDecision {
  /** True when the caller must apply its surface policy (replace / withhold). */
  block: boolean;
  /** Which contract tripped — drives Wide-Event metadata. */
  reason: OutboundReason | null;
}

/** Every language's banks, one module each under `./outbound-screen/locales/`. */
const LOCALE_BANKS: Readonly<Record<Locale, LocaleBank>> = {
  en,
  de,
  fr,
  es,
  it,
  pl,
  nl,
  ko,
  "pt-BR": ptBR,
  ru,
};

/** One value per locale, read off its bank. */
function perLocale<T>(pick: (bank: LocaleBank) => T): Record<Locale, T> {
  return Object.fromEntries(
    locales.map((locale) => [locale, pick(LOCALE_BANKS[locale])]),
  ) as Record<Locale, T>;
}

/**
 * Words a schedule entry's first token may not stand for on its own: a name
 * like "Morning blend" must not make every "skip the morning …" a dose stop.
 */
const NAME_ALIAS_DENY = new Set([
  "morning",
  "evening",
  "night",
  "daily",
  "blood",
  "extra",
  "water",
  "sleep",
  "salt",
  "slow",
  "high",
  "low",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The person's medication names as one alternation, or null. Each schedule
 * entry contributes its name up to the first digit or bracket ("Ramipril 5 mg"
 * → "ramipril") and its first word when that word is long enough to be a drug
 * on its own ("Metformin retard" → "metformin"). A final vowel is dropped from
 * a long name so an inflected form still matches (Polish "amlodypinę",
 * Italian "amlodipina"), and up to four letters of ending or a Korean particle
 * may follow ("ramiprilu", "라미프릴을").
 */
function medicationNameAlternation(
  names: readonly string[] | undefined,
): string | null {
  if (!names || names.length === 0) return null;
  const stems = new Set<string>();
  for (const raw of names.slice(0, 64)) {
    const base = (raw ?? "")
      .toLowerCase()
      .split(/[\d([{/,;+]/)[0]
      .replace(/[.\s]+$/, "")
      .replace(/\s+/g, " ")
      .trim();
    const first = base.split(" ")[0];
    const candidates = [base];
    if (first !== base && first.length >= 4 && !NAME_ALIAS_DENY.has(first)) {
      candidates.push(first);
    }
    for (const candidate of candidates) {
      if ([...candidate].length < 3 || NAME_ALIAS_DENY.has(candidate)) continue;
      const stem =
        candidate.length >= 6 ? candidate.replace(/[aeiouyę]$/, "") : candidate;
      stems.add(stem);
    }
  }
  if (stems.size === 0) return null;
  const alternation = [...stems]
    .sort((x, y) => y.length - x.length)
    .map((stem) => escapeRegExp(stem).replace(/ /g, "\\s+"))
    .join("|");
  return `(?<![${LETTER}])(?:${alternation})[^\\s.,;:!?]{0,4}(?=[\\s.,;:!?'’")]|$)`;
}

/**
 * Dose-prescription banks. Each entry requires a CHANGE verb plus a target
 * dose with a unit, so a permitted factual restatement does not match.
 *
 * The non-EN/DE verb sets are taken from the imperative vocabulary the
 * shipped `safety-contracts.{fr,es,it,pl}.yaml` ground rule 9 bodies use when
 * they forbid the act ("ne recommandez JAMAIS de valeur précise", "NUNCA
 * recomiende un valor concreto", "NON raccomandi MAI un valore specifico",
 * "NIGDY nie zalecać konkretnej wartości") plus the standard clinical
 * titration verbs of each language.
 */

/**
 * The dose-change class, per locale. The banks below this one were written
 * one reported sentence at a time and each fixed the exact shape it was handed,
 * so "Increase your metformin to 2000 mg daily" passed: the English change
 * pattern let only "it" or "your dose" stand between the verb and "to", and a
 * drug name is neither. These patterns state the class instead, in three
 * shapes every locale shares:
 *
 *   1. a change verb in its imperative / infinitive form, up to four words of
 *      object (a drug name, "your dose", "the evening insulin"), and a target
 *      dose — "increase your metformin to 2000 mg", "réduisez votre insuline
 *      à 10 unités";
 *   2. an imperative to take or inject a stated amount — "take 2000 mg daily",
 *      "nimm 2 Tabletten", "prenda 1000 mg";
 *   3. an imperative to halve, double, skip, pause or stop a medication, which
 *      needs no number at all — "skip your evening dose", "stop taking
 *      metformin". A medication noun is required except for the explicit
 *      "stop taking X" form, so "skip your walk" and "double your steps" pass;
 *   4. an imperative to take an extra, another or one more of a medication —
 *      "take an extra ramipril", "nimm abends eine Tablette mehr", "prenez un
 *      comprimé en plus", "weź dodatkową tabletkę".
 *
 * A medication noun is a dosage-form word, a drug-class word ("blood
 * thinner", "Blutverdünner", "anticoagulante"), a common generic-name stem
 * ("-pril", "-dipine"), or one of the person's own medication names when the
 * caller passes them. A count may be spelled out ("two tablets", "zwei
 * Tabletten"). The number-free shapes use a two-word slot that a preposition
 * ends, because they have no unit to anchor them.
 *
 * Verb forms are imperative or infinitive on purpose: the past forms a log
 * restatement uses ("your dose was increased to 2000 mg", "du nimmst 1000 mg")
 * do not match, and the subject pronoun of a present-tense description ("you
 * take", "vous prenez") is outside every lead-in. A clinician referral without
 * a target ("ask your doctor whether to increase your dose") names no dose and
 * passes; one that names a target ("… whether to increase to 2000 mg") stays
 * blocked, the same accepted fail-safe residual as "discussing the 2.4 mg step".
 */
function buildDoseChangeClass(
  names: string | null,
): Record<Locale, readonly RegExp[]> {
  return perLocale((bank) => bank.doseChangeClass(bank.vocabulary(names)));
}

/** The class with no schedule: dosage forms, class words and generic stems. */
const DOSE_CHANGE_CLASS = buildDoseChangeClass(null);

/**
 * The class built over one person's medication names. A turn screens its reply
 * and the trail text of the same turn with the same names, so the compiled set
 * is kept for the most recent schedules rather than rebuilt per call.
 */
const NAMED_CLASS_CACHE = new Map<string, Record<Locale, readonly RegExp[]>>();
const NAMED_CLASS_CACHE_SIZE = 32;

function doseChangeClassFor(
  medicationNames: readonly string[] | undefined,
): Record<Locale, readonly RegExp[]> {
  const names = medicationNameAlternation(medicationNames);
  if (names === null) return DOSE_CHANGE_CLASS;
  const cached = NAMED_CLASS_CACHE.get(names);
  if (cached) return cached;
  const built = buildDoseChangeClass(names);
  if (NAMED_CLASS_CACHE.size >= NAMED_CLASS_CACHE_SIZE) {
    const oldest = NAMED_CLASS_CACHE.keys().next().value;
    if (oldest !== undefined) NAMED_CLASS_CACHE.delete(oldest);
  }
  NAMED_CLASS_CACHE.set(names, built);
  return built;
}

const DOSE_PATTERNS = perLocale((bank) => bank.dose);

/**
 * Risk-score fabrication banks. The model is grounded on a server-computed
 * snapshot and must never invent a clinical risk percentage or a named
 * risk-engine score — those are numbers the server never computed.
 *
 * v1.32.7 (Coach Guard I — D1/D4). The bare-engine and bare-horizon patterns
 * are GONE: a bare mention ("an ASCVD score is what your clinician computes")
 * is education or a refusal, exactly what the system prompt asks for, and the
 * old bank blocked it — the "generic clinical-risk refusal" loop the
 * maintainer kept hitting. A fabrication is the ASSERTION, not the mention:
 *
 *   - a qualifying NUMBER — a digit percent, a spelled-out percent word
 *     ("roughly twelve percent"), or "score of N" — attached to a risk noun,
 *     the 10-year horizon phrase, or a named engine, OR
 *   - a categorical engine/horizon RESULT — "SCORE2 would put you in the
 *     high-risk band" — even with no digits.
 *
 * The horizon token itself ("10-year … risk") is NOT a qualifying number, so a
 * model-perfect refusal that names it passes with no exemption. There is
 * deliberately no refusal-context exemption (it was a hedge-then-assert bypass:
 * "I can't compute your ASCVD, but your risk is about 14%").
 */
/*
 * v1.32.7 narrowed EN + DE only; v1.32.9 (Coach Guard II / B.6) brings fr / es
 * / it / pl to parity: a spelled-out percent counts as a fabricated figure, the
 * named engine blocks with a qualifying number in either order, and a
 * categorical engine RESULT ("SCORE2 vous met dans la tranche à haut risque")
 * blocks numberless. The digit-percent + horizon patterns each locale already
 * shipped stay. Spelled-out cardinals cover 0–19 + the tens a realistic risk
 * percentage uses.
 */
const RISK_PATTERNS = perLocale((bank) => bank.risk);

/**
 * Causal-claim banks — GROUND RULE 12. Descriptive framing stays permitted
 * ("moved with", "was associated with", "assoziiert", "associé à"); only
 * asserted causation trips. This bank is enforced ONLY on the insights-family
 * surfaces the rule declares, never on the Coach.
 */
const CAUSAL_PATTERNS = perLocale((bank) => bank.causal);

const BANKS: Record<OutboundContract, Record<Locale, readonly RegExp[]>> = {
  dose: DOSE_PATTERNS,
  risk: RISK_PATTERNS,
  causal: CAUSAL_PATTERNS,
};

const REASON_FOR_CONTRACT: Record<OutboundContract, OutboundReason> = {
  dose: "dose_prescription",
  risk: "risk_score",
  causal: "causal_claim",
};

/**
 * The contract set every conversational surface enforces. Causal framing is
 * deliberately absent — see the module header.
 */
export const CONVERSATIONAL_CONTRACTS: readonly OutboundContract[] = [
  "dose",
  "risk",
];

/** The contract set every insights-family surface enforces (adds GROUND RULE 12). */
export const INSIGHTS_CONTRACTS: readonly OutboundContract[] = [
  "dose",
  "risk",
  "causal",
];

/**
 * Continuation-exclusion for the dose bank (v1.32.7 — D7). A sentence that
 * matches a dose pattern is EXEMPT only when it is anchored to a maintenance
 * object ("keep taking … as prescribed"), carries no change stem, AND every
 * amount it states sits beside one of the person's medications, named, at
 * exactly that planned dose. So "keep taking your semaglutide 7.5 mg as
 * prescribed" passes for someone on semaglutide 7.5 mg, an unnamed "keep
 * taking your 7.5 mg" does not, while
 * "you should keep in mind that trying 5 mg" (no maintenance anchor) and
 * "you should continue tapering to 2.4 mg" (a change stem present) stay
 * blocked. The direction is exclusion-of-continuation, never
 * requirement-of-change — "you should try 5 mg" must keep blocking.
 *
 * The plan check is not optional. The phrase alone used to be enough on every
 * surface that passed no schedule, so "Take 40 mg as before." went out from
 * a nudge or a briefing to someone who had never taken 40 mg of anything: "as
 * before" is the model's claim, and only the plan can confirm it. A surface
 * without the plan cannot exempt a stated amount at all.
 *
 * Accepted residual FP, failing safe: "I'd recommend discussing the 2.4 mg
 * step with your doctor" stays blocked ("step" is a change stem).
 */
const DOSE_CONTINUATION = perLocale((bank) => bank.continuation);

const DOSE_CHANGE_STEM = perLocale((bank) => bank.changeStem);

/** Sentence-level split — the dose exemption must be scoped to one sentence. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!\n])\s+/);
}

/** Every leading-magnitude dose value in one sentence ("keep your 7.5 mg" → [7.5]). */
const DOSE_VALUE_RE = new RegExp(`([\\d.,]+)\\s*${DOSE_UNIT}${UNIT_END}`, "gi");

function sentenceDoseValues(sentence: string): number[] {
  const values: number[] = [];
  let m: RegExpExecArray | null;
  DOSE_VALUE_RE.lastIndex = 0;
  while ((m = DOSE_VALUE_RE.exec(sentence)) !== null) {
    // Normalise a comma decimal ("7,5") and a stray thousands/decimal tail.
    const cleaned = m[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const value = Number.parseFloat(cleaned);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** True when a dose value equals a planned one (exact / ±2%). */
function sameDose(value: number, planned: number): boolean {
  return Math.abs(value - planned) <= Math.max(0.01, Math.abs(planned) * 0.02);
}

const INN_STEM_RE = new RegExp(INN_STEM, "i");

/**
 * Where one stated amount ends and the next begins: a comma before a space
 * (a decimal comma, "7,5", is not one), a semicolon, "and" / "or".
 */
const CLAUSE_SPLIT =
  /,(?=\s)|;|\s(?:and|und|en|et|y|e|i|oraz|plus|sowie|ou|o|or|oder)\s|그리고|및/i;

/**
 * True when every amount a continuation sentence states is paired with one
 * of the person's medications, named beside it, at exactly that dose. Each
 * clause that states an amount must name exactly one medication on the plan
 * (as it is written on the plan, the only alias the screen can know), and
 * every amount in it must be one of that medication's planned doses. An
 * amount with no name beside it, a name the plan does not carry (a brand
 * like "Eliquis" is simply not a plan name; a generic stem like "apixaban"
 * is recognised and refused), or a dose that belongs to another medication
 * on the plan ("ramipril 500 mg and metformin 5 mg") is never trusted.
 */
function continuationMatchesPlan(
  sentence: string,
  plan: readonly ScheduledDose[] | undefined,
): boolean {
  if (!plan || plan.length === 0) return false;
  const matchers = plan.map((entry) => {
    const alternation = medicationNameAlternation([entry.name]);
    return alternation === null ? null : new RegExp(alternation, "gi");
  });
  let stated = 0;
  for (const clause of sentence.split(CLAUSE_SPLIT)) {
    const values = sentenceDoseValues(clause);
    if (values.length === 0) continue;
    stated += values.length;
    const named = plan.filter((_, i) => matchers[i]?.test(clause) ?? false);
    matchers.forEach((m) => m && (m.lastIndex = 0));
    const names = new Set(named.map((entry) => entry.name.toLowerCase()));
    if (names.size !== 1) return false;
    // A generic name left once the plan's own names are taken out is a drug
    // the plan does not carry.
    const rest = matchers.reduce(
      (text, m) => (m ? text.replace(m, " ") : text),
      clause,
    );
    if (INN_STEM_RE.test(rest)) return false;
    if (!values.every((v) => named.some((e) => sameDose(v, e.dose)))) {
      return false;
    }
  }
  return stated > 0;
}

/** True when a dose-change imperative trips, honouring the continuation rule. */
function doseTrips(
  subject: string,
  locale: Locale,
  dosePlan?: readonly ScheduledDose[],
  medicationNames?: readonly string[],
): boolean {
  const bank = BANKS.dose;
  const changeClass = doseChangeClassFor(medicationNames);
  const own = (l: Locale) => [...bank[l], ...changeClass[l]];
  const patterns = locale === "en" ? own("en") : [...own(locale), ...own("en")];
  const continuation =
    locale === "en"
      ? [DOSE_CONTINUATION.en]
      : [DOSE_CONTINUATION[locale], DOSE_CONTINUATION.en];
  const changeStem =
    locale === "en"
      ? [DOSE_CHANGE_STEM.en]
      : [DOSE_CHANGE_STEM[locale], DOSE_CHANGE_STEM.en];
  for (const sentence of splitSentences(subject)) {
    if (!patterns.some((p) => p.test(sentence))) continue;
    const exempt =
      continuation.some((p) => p.test(sentence)) &&
      !changeStem.some((p) => p.test(sentence)) &&
      continuationMatchesPlan(sentence, dosePlan);
    if (!exempt) return true;
  }
  return false;
}

/**
 * Screen one assembled model output.
 *
 * Contracts are evaluated in the caller's declared order, so the reason a
 * caller annotates is stable: dose first (highest medical-safety leverage),
 * then risk, then causal. Each contract runs the reader's locale bank plus the
 * EN bank.
 */
export interface ScreenOptions {
  /**
   * The person's active medications with their dose magnitudes. A "keep
   * taking your X N mg" is trusted only when X is a medication on this plan,
   * named beside the amount, planned at exactly N; an unnamed amount, a name
   * the plan does not carry, or a dose of another medication is never
   * exempt, and without the plan no stated amount is.
   */
  dosePlan?: readonly ScheduledDose[];
  /**
   * The person's own medication names, as typed into their schedule. Each one
   * counts as a medication noun in the dose-change class, so "skip the
   * Eliquis" and "take an extra ramipril" block like "skip your dose". A brand
   * name is only known this way; generic names are also caught by their stem.
   */
  medicationNames?: readonly string[];
}

export function screenModelOutput(
  text: string,
  locale: Locale,
  contracts: readonly OutboundContract[],
  opts?: ScreenOptions,
): OutboundDecision {
  const subject = text ?? "";
  if (subject.trim().length === 0) return { block: false, reason: null };

  for (const contract of contracts) {
    if (contract === "dose") {
      // Dose is sentence-scoped so the continuation exemption cannot be
      // voided by a change stem in an unrelated sentence.
      if (doseTrips(subject, locale, opts?.dosePlan, opts?.medicationNames)) {
        return { block: true, reason: REASON_FOR_CONTRACT.dose };
      }
      continue;
    }
    const bank = BANKS[contract];
    // The reader's bank plus EN — a provider often answers in English
    // regardless of the locale directive, and EN carries the proven shapes.
    const patterns = locale === "en" ? bank.en : [...bank[locale], ...bank.en];
    for (const pattern of patterns) {
      if (pattern.test(subject)) {
        return { block: true, reason: REASON_FOR_CONTRACT[contract] };
      }
    }
  }
  return { block: false, reason: null };
}
