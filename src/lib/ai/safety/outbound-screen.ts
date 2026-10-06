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
import type { Locale } from "@/lib/i18n/config";

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

/**
 * Count units — a dose expressed as a number of dosage forms ("2 tablets",
 * "zwei Hübe" written as "2 Hübe", "1 comprimé"). The same forms the
 * medication wizard offers (`src/lib/medications/dose-units.ts`), in every
 * locale the banks cover. Without them "take 3 tablets a day" carried no unit
 * the screen recognised and passed every pattern.
 */
const COUNT_UNIT =
  "(?:tablets?|pills?|capsules?|drops?|puffs?|sprays?|tabletten?|kapseln?|tropfen|hübe|hub|sprühstöße|comprimés?|gélules?|gouttes?|bouffées?|comprimidos?|pastillas?|c[áa]psulas?|gotas?|compress[ae]|pastigli[ae]|gocce|goccia|tabletk[aęiy]|tabletek|kapsułk[aęiy]|kapsułek|krople|kropli)";

/**
 * Dose units for a target dose a model must never name. Mass and insulin
 * units plus the count forms; `ml` is left out on purpose because
 * "increase your water intake to 2000 ml" is ordinary hydration advice.
 */
const DRUG_UNIT = `(?:mg|mcg|µg|iu|i\\.u\\.|units?|unidades?|unità|unités?|jednostek|jednostki|ie|i\\.e\\.|einheiten|${COUNT_UNIT})`;

/**
 * Dose units, shared across every locale. The GLP-1 + general oral-dose
 * vocabulary; `ie` / `i.e.` / `einheiten` / `unità` / `jednostk` cover the
 * insulin-unit spellings the six locales use.
 */
const DOSE_UNIT = `(?:ml|${DRUG_UNIT})`;

/**
 * What may follow a dose unit. A concentration is a lab value, not a dose:
 * "keep your glucose under 140 mg/dL" and "eGFR above 60 ml/min" name no
 * medication, and a bare `\b` let both trip the "try … N mg" pattern. A
 * per-day or per-kilogram rate ("2000 mg/day", "10 mg/kg") IS a dose and still
 * matches. The lookahead also ends a unit that closes on a non-word letter
 * ("unità", "i.e.") where `\b` cannot.
 */
const UNIT_END = "(?!\\w|\\s*\\/\\s*(?:dl|l|min|mmol)\\b)";

/**
 * One to four words of object between a change verb and its target — "your
 * metformin", "the evening insulin dose", "votre metformine". The original
 * English pattern accepted only "it" or "your dose" in that slot, so naming the
 * drug ("increase your metformin to 2000 mg") walked past the screen.
 *
 * A word may not be a digit run, a sentence break, a negation (a negated
 * imperative is a warning, not an instruction), a clause joiner, or a
 * dietary noun: "lower your sodium to 1500 mg" and "cut caffeine to 200 mg"
 * are nutrition guidance, not a dose change.
 */
function objectSlot(stopWords: string, maxWords = 4): string {
  return `(?:(?!(?:${stopWords})(?=\\s))[^\\s\\d.?!,;:]+\\s+){0,${maxWords}}?`;
}

const EN_STOP =
  "not|never|and|or|but|if|whether|when|sodium|salt|caffeine|sugars?|fib(?:er|re)|protein|carbs?|carbohydrates?|cholesterol|water|fluids?|coffee|alcohol|steps";
const DE_STOP =
  "nicht|nie|niemals|kein\\w*|und|oder|aber|wenn|ob|natrium|salz|koffein|zucker|wasser|eiweiß|protein|ballaststoff\\w*|kalorien";
const FR_STOP =
  "pas|jamais|ne|et|ou|mais|si|sodium|sel|caféine|sucres?|eau|protéines?|fibres?";
const ES_STOP =
  "no|nunca|y|o|pero|si|sodio|sal|cafeína|azúcar|agua|proteínas?|fibra";
const IT_STOP =
  "non|mai|e|o|ma|se|sodio|sale|caffeina|zucchero|acqua|proteine|fibre";
const PL_STOP =
  "nie|i|lub|albo|ale|jeśli|czy|sód|sodu|sól|soli|kofein\\S*|cukr\\S*|wod\\S*|białk\\S*|błonnik\\S*";

const EN_SLOT = objectSlot(EN_STOP);
const DE_SLOT = objectSlot(DE_STOP);
const FR_SLOT = objectSlot(FR_STOP);
const ES_SLOT = objectSlot(ES_STOP);
const IT_SLOT = objectSlot(IT_STOP);
const PL_SLOT = objectSlot(PL_STOP);

/**
 * A tighter slot for the shapes that carry no number: an extra / one more /
 * stop imperative. At most two words, and a preposition ends it, so "take an
 * extra minute to log your medication" and "stop worrying about your
 * medication" never reach the medication noun.
 */
const EN_SHORT = objectSlot(
  `${EN_STOP}|to|for|with|at|in|on|of|from|before|after|about|into|than|while|during|like`,
  2,
);
const DE_SHORT = objectSlot(
  `${DE_STOP}|als|zu|mit|für|gegen|statt|ohne|über`,
  2,
);
const FR_SHORT = objectSlot(
  `${FR_STOP}|pour|avec|avant|après|sans|à|au|aux`,
  2,
);
const ES_SHORT = objectSlot(`${ES_STOP}|para|con|antes|después|sin|a|al`, 2);
const IT_SHORT = objectSlot(`${IT_STOP}|per|con|prima|dopo|senza|a|al`, 2);
const PL_SHORT = objectSlot(`${PL_STOP}|z|ze|do|na|po|przed|bez|dla`, 2);

/**
 * A count written as a word: "take two tablets", "nimm zwei Tabletten",
 * "prenez deux comprimés", "weź dwie tabletki". The union of every covered
 * locale, because a provider mixes languages. Articles ("a", "un", "eine")
 * are left out on purpose: "take a tablet with food" is an article, not a
 * count, and the "eine Tablette mehr" shape is its own pattern below.
 */
const SPELLED_COUNT =
  "(?:one|two|three|four|five|six|half\\s+an?|zwei|drei|vier|fünf|sechs|eine?n?\\s+halbe|halbe|deux|trois|quatre|cinq|demi|dos|tres|cuatro|cinco|media|due|tre|quattro|cinque|mezza|dwie|dwa|trzy|cztery|pięć|jedn[ąa]|pół)";

/** A target dose: a number, a drug unit, and an honest unit end. */
const TARGET = `(?:[\\d.,]+\\s*${DRUG_UNIT}${UNIT_END}|(?<![\\w])${SPELLED_COUNT}\\s+${COUNT_UNIT}${UNIT_END})`;

/**
 * Where an English imperative can start: the sentence head (or a list bullet),
 * after a colon / dash, or after a recommending lead-in. A negated imperative
 * ("don't skip your dose") never reaches the verb from any of these.
 */
const EN_LEAD =
  "(?:^\\s*(?:[-*•]\\s*|\\d+[.)]\\s*)?|[:;—–]\\s*|(?<!\\b(?:whether|if)\\s)\\b(?:please|just|then|now|instead|so|you\\s+(?:should|need\\s+to|must|ought\\s+to)|try\\s+to|go\\s+ahead\\s+and|i'?d|i\\s+would|time\\s+to)\\s+)";

/** A recommending cue that may sit in front of a gerund / infinitive change. */
const EN_CUE =
  "\\b(?:consider|try|recommend|suggest|worth|might\\s+want\\s+to|may\\s+want\\s+to|need\\s+to|time\\s+to|i'?d|i\\s+would|should|could)\\b";

/** The letters a drug name is spelled with in the Latin-script locales. */
const LETTER = "a-zà-ÿąćęłńóśźż";

/**
 * Medication nouns, per locale: the dosage-form and treatment words.
 */
const EN_MED_NOUN =
  "(?:dose|doses|dosage|pill|pills|tablet|tablets|capsule|capsules|medication|medications|medicine|meds|insulin|injection|injections|shot|jab|inhaler)\\b";
const DE_MED_NOUN =
  "\\S*(?:dosis|tablette\\w*|medikament\\w*|medikation|spritze\\w*|insulin|pille\\w*|kapsel\\w*)";
const FR_MED_NOUN =
  "(?:doses?|comprimés?|médicaments?|traitement|insuline|injections?|piqûres?|pilules?|gélules?|cachets?)";
const ES_MED_NOUN =
  "(?:dosis|pastillas?|comprimidos?|medicamentos?|medicaci[óo]n|insulina|inyecci[óo]n|inyecciones|c[áa]psulas?|tratamiento)";
const IT_MED_NOUN =
  "(?:dos[ei]|compress[ae]|pastigli[ae]|farmac[oi]|medicinal[ei]|insulina|iniezion[ei]|capsul[ae]|terapia)";
const PL_MED_NOUN =
  "(?:dawk[aęiy]|dawek|tabletk[aęiy]|tabletek|lek|leki|leku|leków|insulin[aęy]|zastrzyk[ia]?|zastrzyków|kapsułk[aęiy]|pigułk[aęiy])(?=[\\s.,;:!?]|$)";
const KO_MED_NOUN =
  "(?:약을|약은|약\\s|알약|정제|인슐린|주사|용량|복용량|투약)";

/**
 * Generic drug-class words, per locale. "Stop your blood thinner" names no
 * dosage form and no drug, and it is the most dangerous stop of all.
 */
const MED_CLASS: Record<Locale, string> = {
  en: "(?:blood[- ]?thinners?|anti-?coagulants?|anti-?platelets?|statins?|beta[- ]?blockers?|diuretics?|water\\s+pills?|ace\\s+inhibitors?|steroids?|antidepressants?|sleeping\\s+pills?)\\b",
  de: "\\S*(?:blutverdünner\\w*|gerinnungshemmer\\w*|antikoagul\\w*|statin\\w*|betablocker\\w*|diuretik\\w*|wassertablette\\w*|blutdrucksenker\\w*|antidepressiv\\w*|schlaftablette\\w*)",
  fr: "(?:anticoagulants?|antiagrégants?|statines?|bêta-?bloquants?|diurétiques?|antidépresseurs?|somnifères?)",
  es: "(?:anticoagulantes?|antiagregantes?|estatinas?|betabloqueantes?|diuréticos?|antidepresivos?)",
  it: "(?:anticoagulant[ei]|antiaggregant[ei]|statin[ae]|betabloccant[ei]|diuretic[oi]|antidepressiv[oi])",
  pl: "(?:lek\\S*\\s+przeciwzakrzepow\\S*|antykoagulant\\S*|statyn\\S*|beta-?bloker\\S*|diuretyk\\S*|lek\\S*\\s+moczopędn\\S*|antydepresant\\S*)",
  ko: "(?:혈액\\s*희석제|항응고제|항혈소판제|스타틴|베타\\s*차단제|이뇨제|항우울제)",
};

/**
 * Common generic-name stems (INN): ramipril, losartan, bisoprolol,
 * atorvastatin, amlodipine, metformin, semaglutide, apixaban, omeprazole,
 * furosemide. A surface that passes no schedule (a nudge, the document chat)
 * still recognises "skip the amlodipine". Two letters must precede the stem,
 * so "April" is not a drug; the stems are chosen so no everyday word ends in
 * one ("comparing" is why heparin is spelled out rather than stemmed).
 */
const INN_STEM = `(?<![${LETTER}])[${LETTER}]{2,}(?:pril|sartan|olol|statin|dipin|dypin|formin|glutid|gliflozin|gliptin|xaban|ksaban|prazol|semid)[${LETTER}]{0,4}(?![${LETTER}])|(?<![${LETTER}])(?:enoxa|dalte)?heparin[${LETTER}]{0,4}`;

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

/** The medication-noun alternation each locale's patterns use. */
type MedVocabulary = Record<Locale, string>;

/**
 * Build each locale's medication noun from the dosage-form words, the class
 * words, the generic stems and the person's own names. An elided article
 * ("l'amlodipine", "dell'insulina") may sit in front of a French or Italian
 * noun.
 */
function medVocabulary(names: string | null): MedVocabulary {
  const extra = (locale: Locale) =>
    [MED_CLASS[locale], locale === "ko" ? null : INN_STEM, names]
      .filter((part): part is string => part !== null)
      .join("|");
  const elided = "(?:[a-z]{1,4}['’])?";
  return {
    en: `(?:${EN_MED_NOUN}|${extra("en")})`,
    de: `(?:${DE_MED_NOUN}|${extra("de")})`,
    fr: `${elided}(?:${FR_MED_NOUN}|${extra("fr")})`,
    es: `(?:${ES_MED_NOUN}|${extra("es")})`,
    it: `${elided}(?:${IT_MED_NOUN}|${extra("it")})`,
    pl: `(?:${PL_MED_NOUN}|${extra("pl")})`,
    ko: `(?:${KO_MED_NOUN}|(?:${extra("ko")})\\S{0,3})`,
  };
}

/**
 * Korean dosage-form counters. They attach to the digit with no space ("2정",
 * "10단위"); `정` is guarded against "정상" (normal) and `알` against "알레르기".
 */
const KO_COUNT = "(?:단위|유닛|캡슐|정(?!상|도|확|말)|알(?!레))";
const KO_TARGET = `(?:[\\d.,]+(?:\\s*${DRUG_UNIT}${UNIT_END}|${KO_COUNT})|(?:한|두|세|네|반)\\s*(?:알(?!레)|정(?!상|도|확|말)|캡슐))`;

/**
 * A Korean imperative or recommendation that closes a dose clause. The stem
 * must meet the polite-imperative ending directly, so the prohibitive
 * "건너뛰지 마세요" (don't skip) and "줄이지 마세요" (don't lower) never match.
 */
const KO_IMPERATIVE =
  "(?:(?:늘리|올리|높이|줄이|내리|낮추|증량하|감량하|중단하|끊으|건너뛰|멈추|복용하|드시|드|투여하|맞으|주사하|바꾸|변경하)(?:세요|십시오|시기\\s*바랍니다|셔야|는\\s*(?:것이|게)\\s*좋)|(?:늘려|올려|높여|줄여|내려|낮춰|끊어|멈춰|바꿔|드셔|복용해|투여해|증량해|감량해|중단해)\\s*(?:보세요|주세요|보십시오|야\\s*(?:해요|합니다)))";

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
 * The object a German change verb may carry before its target ("erhöhe
 * deine Dosis auf 2,4 mg"). English allows "your dose" in the same slot;
 * without it the German imperative with an object slipped through.
 */
const DE_DOSE_OBJECT =
  "(?:\\s+(?:(?:deine|die|ihre|eure|seine)\\s+)?(?:dosis|dosierung|medikation|wochendosis|tagesdosis))?";

/** A German count in front of a medication noun ("eine Tablette mehr"). */
const DE_COUNT = "ein(?:e|en)?|zwei|drei|vier|halbe|\\d+(?:[.,]\\d+)?";

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
  m: MedVocabulary,
): Record<Locale, readonly RegExp[]> {
  return {
    en: [
      new RegExp(
        `\\b(?:increase|raise|up|bump|boost|titrate|step|move|go|ramp|push|switch|change|adjust|lower|reduce|cut|drop|decrease|taper|halve|double|trim|bring)\\s+${EN_SLOT}(?:from\\s+${TARGET}\\s+)?(?:up\\s+|down\\s+|back\\s+)?(?:to|by)\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `${EN_CUE}[^.?!]{0,20}?\\b(?:increas(?:e|ing)|rais(?:e|ing)|bump(?:ing)?|boost(?:ing)?|titrat(?:e|ing)|lower(?:ing)?|reduc(?:e|ing)|cut(?:ting)?|drop(?:ping)?|decreas(?:e|ing)|taper(?:ing)?|halv(?:e|ing)|doubl(?:e|ing)|switch(?:ing)?|adjust(?:ing)?|go(?:ing)?\\s+up|step(?:ping)?\\s+up)\\s+${EN_SLOT}(?:from\\s+${TARGET}\\s+)?(?:up\\s+|down\\s+)?(?:to|by)\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `${EN_LEAD}(?:take|start\\s+(?:taking|on|with|at)|begin\\s+(?:taking|with|at)|inject|use|give\\s+yourself)\\s+${EN_SLOT}${TARGET}`,
        "im",
      ),
      new RegExp(
        `${EN_LEAD}(?:halve|double|skip|pause|hold|drop|miss|split|cut)\\s+${EN_SLOT}${m.en}`,
        "im",
      ),
      new RegExp(
        `${EN_LEAD}(?:(?:(?:stop|quit)\\s+(?:taking|injecting)|discontinue)\\s+\\S|(?:come|wean\\s+(?:yourself\\s+)?)\\s*off\\s+${EN_SLOT}${m.en})`,
        "im",
      ),
      new RegExp(
        `${EN_CUE}[^.?!]{0,20}?\\b(?:(?:halv|doubl|skipp|paus|hold|dropp|miss|splitt|cutt)ing\\s+${EN_SLOT}${m.en}|(?:stopping|quitting)\\s+(?:taking|injecting)\\s+\\S|discontinuing\\s+\\S|coming\\s+off\\s+${EN_SLOT}${m.en})`,
        "i",
      ),
      // An extra, another or one more of a medication: "take an extra
      // ramipril", "take one more tablet of ramipril". The short slot ends at a
      // preposition, so "take an extra minute to log your medication" passes.
      new RegExp(
        `${EN_LEAD}(?:take|use|inject|add|give\\s+yourself|pop)\\s+(?:another|(?:(?:an?|one|two|three|\\d+)\\s+)?(?:extra|additional|more|further|second))\\s+${EN_SHORT}${m.en}`,
        "im",
      ),
      // Stop, leave out or go without a named medication or a drug class:
      // "stop your blood thinner", "leave out the Eliquis".
      new RegExp(
        `${EN_LEAD}(?:stop|quit|discontinue|omit|leave\\s+out|hold\\s+off\\s+on|go\\s+without)\\s+${EN_SHORT}${m.en}`,
        "im",
      ),
      new RegExp(`${EN_LEAD}leave\\s+${EN_SHORT}${m.en}\\s+out\\b`, "im"),
      // The same behind a recommending cue. A referral ("before", "ask",
      // "whether") or a negation between the cue and the verb ends it.
      new RegExp(
        `${EN_CUE}(?:(?!\\b(?:not|never|before|without|until|unless|ask|asking|whether|if)\\b)[^.?!]){0,20}?\\b(?:(?:stopping|omitting|leaving\\s+out)\\s+${EN_SHORT}${m.en}|taking\\s+(?:another|(?:(?:an?|one|two|\\d+)\\s+)?(?:extra|additional|more))\\s+${EN_SHORT}${m.en})`,
        "i",
      ),
    ],
    de: [
      new RegExp(
        `\\b(?:erhöh(?:e|en)?|steiger(?:e|n)?|reduzier(?:e|en)?|senk(?:e|en)?|verringer(?:e|n)?|halbier(?:e|en)?|verdopp(?:e?le|eln)|stell(?:e|en)?|geh(?:e)?|setz(?:e|en)?|bring(?:e|en)?)(?:\\s+sie)?\\s+${DE_SLOT}(?:(?:hoch|rauf|runter|herunter)\\s+)?(?:auf|um)\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `\\b(?:nimm|nehmen\\s+sie|spritz|spritzen\\s+sie|injizier(?:e)?|injizieren\\s+sie|beginn(?:e)?\\s+mit|beginnen\\s+sie\\s+mit|starte\\s+mit)\\s+${DE_SLOT}${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<![${LETTER}])(?:halbier(?:e|en)?|verdopp(?:e?le|eln)|pausier(?:e|en)?|überspring(?:e|en)?|stopp(?:e|en)?)(?:\\s+sie)?\\s+${DE_SLOT}${m.de}`,
        "i",
      ),
      new RegExp(
        `\\b(?:setz(?:e|en)?)(?:\\s+sie)?(?:\\s+(?!(?:nicht|nie|niemals|kein\\w*)(?=\\s))[^\\s.?!,;:]+){1,4}?\\s+ab(?=\\s*(?:[.?!,;:]|$|und\\s|oder\\s))`,
        "i",
      ),
      new RegExp(
        `\\b(?:lass|lassen\\s+sie)\\s+${DE_SLOT}${m.de}(?:(?!\\b(?:nicht|nie|niemals)\\b)[^.?!]){0,20}?\\b(?:aus|weg)\\b`,
        "i",
      ),
      new RegExp(
        `\\bh(?:ör(?:e)?|ören\\s+sie)\\s+(?:mit\\s+\\S+\\s+)?auf\\b[^.?!]{0,40}?\\b(?:zu\\s+nehmen|einzunehmen|zu\\s+spritzen)`,
        "i",
      ),
      new RegExp(
        `\\b(?:solltest|sollten\\s+sie|empfehle|rate\\s+(?:dir|ihnen)|würde\\s+ich)\\b(?:(?!\\b(?:nicht|nie|niemals|kein\\w*)\\b)[^.?!]){0,40}?\\b(?:absetzen|abzusetzen|halbieren|zu\\s+halbieren|verdoppeln|zu\\s+verdoppeln|auslassen|auszulassen|weglassen|wegzulassen|pausieren|zu\\s+pausieren)\\b`,
        "i",
      ),
      // "eine Tablette mehr", "noch eine Tablette", "eine zusätzliche
      // Tablette", "mehr Insulin". A negation ("keine") cannot enter the slot.
      new RegExp(
        `\\b(?:nimm|nehmen\\s+sie|spritz|spritzen\\s+sie|injizier(?:e)?|injizieren\\s+sie)\\s+${DE_SHORT}(?:(?:noch\\s+)?(?:${DE_COUNT})\\s+${DE_SHORT}${m.de}\\s+mehr\\b|noch\\s+(?:${DE_COUNT})\\s+${DE_SHORT}${m.de}|(?:(?:${DE_COUNT})\\s+)?(?:zusätzlich\\w*|extra|weitere\\w*|mehr)[-\\s]+${DE_SHORT}${m.de})`,
        "i",
      ),
      new RegExp(
        `\\bh(?:ör(?:e)?|ören\\s+sie)\\s+mit\\s+${DE_SHORT}${m.de}\\s+auf\\b`,
        "i",
      ),
      new RegExp(
        `\\bverzichte(?:n\\s+sie)?\\s+${DE_SHORT}auf\\s+${DE_SHORT}${m.de}`,
        "i",
      ),
    ],
    fr: [
      new RegExp(
        `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)(?<!n['’])\\b(?:(?:augment|mont|pass|port|major|diminu|baiss|abaiss|doubl|ramen)(?:ez|e|er)|r[ée]dui(?:sez|s|re))\\s+${FR_SLOT}(?:de\\s+${TARGET}\\s+)?(?:[àa]|de|jusqu'[àa])\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)\\b(?:prenez|prends|injectez|injecte|commencez\\s+(?:par|à|avec))\\s+${FR_SLOT}${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)(?<!n['’])\\b(?:divisez|doublez|sautez|suspendez|interrompez|oubliez|arrêtez|cessez|stoppez|supprimez)\\s+${FR_SLOT}${m.fr}`,
        "i",
      ),
      new RegExp(
        `(?<!n['’])\\b(?:arrêtez|cessez|stoppez)\\s+de\\s+(?:prendre|vous\\s+injecter)\\b`,
        "i",
      ),
      new RegExp(
        `\\b(?:vous\\s+devriez|je\\s+recommande\\s+de|je\\s+sugg[èe]re\\s+de|envisagez\\s+de|essayez\\s+de)\\s+(?:sauter|suspendre|arrêter|interrompre|diviser|doubler)\\s+${FR_SLOT}(?:de\\s+prendre\\s+\\S|${m.fr})`,
        "i",
      ),
      // "un comprimé en plus", "un ramipril supplémentaire", "un autre
      // comprimé", "encore une dose".
      new RegExp(
        `(?<!\\bne\\s)(?<!\\b(?:vous|nous|je|tu|il|elle|on)\\s)\\b(?:prenez|prends|injectez|ajoutez)\\s+${FR_SHORT}(?:(?:encore\\s+)?(?:un|une|deux|trois|\\d+)\\s+${FR_SHORT}${m.fr}[^.?!]{0,30}?(?:\\ben\\s+plus\\b|\\bde\\s+plus\\b|\\bsuppl[ée]mentaires?)|(?:un|une)\\s+autres?\\s+${FR_SHORT}${m.fr}|encore\\s+(?:un|une)\\s+${FR_SHORT}${m.fr})`,
        "i",
      ),
    ],
    es: [
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:aumente|aumenta|aumentar|suba|sube|subir|pase|pasar|incremente|incrementar|reduzca|reduce|reducir|baje|bajar|disminuya|disminuir|duplique|duplicar|lleve|llevar|ajuste|ajustar)\\s+${ES_SLOT}(?:de\\s+${TARGET}\\s+)?(?:a|en|hasta)\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:tome|tómese|inyecte|inyéctese|administre|empiece\\s+con|comience\\s+con)\\s+${ES_SLOT}${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:omita|sáltese|salte|suspenda|interrumpa|duplique|divida|parta)\\s+${ES_SLOT}${m.es}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:deje|deja|dejar)\\s+de\\s+(?:tomar|usar|inyectarse)\\b`,
        "i",
      ),
      // "una pastilla de más", "otra pastilla", "una dosis extra".
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:tome|tómese|inyecte|inyéctese|añada|agregue)\\s+${ES_SHORT}(?:(?:un|una|dos|tres|\\d+)\\s+${ES_SHORT}${m.es}[^.?!]{0,20}?(?:\\bm[áa]s(?![${LETTER}])|\\bextra\\b|\\badicional(?:es)?\\b)|otr[oa]s?\\s+${ES_SHORT}${m.es})`,
        "i",
      ),
      // Stop a named medication or a drug class: "deje el anticoagulante".
      new RegExp(
        `(?<!\\b(?:no|nunca)\\s)\\b(?:deje|pare|abandone)\\s+${ES_SHORT}${m.es}`,
        "i",
      ),
    ],
    it: [
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:aumenti|aumentare|incrementi|incrementare|porti|portare|passi|passare|salga|salire|riduca|ridurre|abbassi|abbassare|diminuisca|diminuire|dimezzi|dimezzare|raddoppi|raddoppiare)\\s+${IT_SLOT}(?:da\\s+${TARGET}\\s+)?(?:a|di|fino\\s+a)\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:prenda|assuma|inietti|si\\s+inietti|inizi\\s+con|cominci\\s+con)\\s+${IT_SLOT}${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:salti|sospenda|interrompa|dimezzi|raddoppi|divida|ometta|tralasci|smetta)\\s+${IT_SLOT}${m.it}`,
        "i",
      ),
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\bsmett(?:a|i|ere)\\s+di\\s+(?:prendere|assumere|usare)\\b`,
        "i",
      ),
      // "una compressa in più", "un'altra compressa", "una dose extra".
      new RegExp(
        `(?<!\\b(?:non|mai)\\s)\\b(?:prenda|assuma|inietti|aggiunga)\\s+${IT_SHORT}(?:(?:un|una|uno|due|tre|\\d+)\\s+${IT_SHORT}${m.it}[^.?!]{0,30}?(?:\\bin\\s+più|\\bextra\\b|\\baggiuntiv[aoei]\\b|\\bin\\s+aggiunta\\b)|(?:un['’]altra|un\\s+altro|altr[eio])\\s*${IT_SHORT}${m.it})`,
        "i",
      ),
    ],
    pl: [
      new RegExp(
        `(?<!\\bnie\\s)\\b(?:zwi[ęe]ksz(?:y[ćc]|cie)?|podnie[śs](?:[ćc]|cie)?|podwy[żz]sz(?:y[ćc])?|zmniejsz(?:y[ćc]|cie)?|obni[żz](?:y[ćc]|cie)?|zredukuj(?:cie)?|zredukowa[ćc]|przejd[źz](?:cie)?|przej[śs][ćc]|zmie[ńn]|zmieni[ćc])(?=\\s)\\s+${PL_SLOT}(?:z\\s+${TARGET}\\s+)?(?:do|o|na)\\s+${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?:(?<!\\bnie\\s)\\b(?:przyjmij|przyjmuj|we[źz]|bierz|wstrzyknij|wstrzykuj|zacznij\\s+od)|\\b(?:proszę|należy|warto)\\s+(?:przyj[ąa][ćc]|wzi[ąa][ćc]|bra[ćc]|przyjmowa[ćc]|wstrzykiwa[ćc]|wstrzykn[ąa][ćc]|zacz[ąa][ćc]\\s+od))(?=\\s)\\s+${PL_SLOT}${TARGET}`,
        "i",
      ),
      new RegExp(
        `(?:(?<!\\bnie\\s)\\b(?:pomi[ńn](?:cie)?|opu[śs][ćc]|odstaw(?:cie)?|wstrzymaj|podziel|podwój)|\\b(?:proszę|należy|warto)\\s+(?:pomin[ąa][ćc]|odstawi[ćc]|wstrzyma[ćc]|przerwa[ćc]|podzieli[ćc]|podwoi[ćc]))(?=\\s)\\s+${PL_SLOT}${m.pl}`,
        "i",
      ),
      new RegExp(
        `(?:(?<!\\bnie\\s)\\bprzesta[ńn](?:cie)?|\\b(?:proszę|należy)\\s+przesta[ćc])\\s+(?:brać|przyjmować|stosować)(?=[\\s.,;:!?]|$)`,
        "i",
      ),
      // "dodatkową tabletkę", "jeszcze jedną dawkę", "jedną tabletkę więcej".
      new RegExp(
        `(?:(?<!\\bnie\\s)\\b(?:we[źz]|bierz|przyjmij|wstrzyknij|dodaj)|\\b(?:proszę|należy|warto)\\s+(?:wzi[ąa][ćc]|przyj[ąa][ćc]|wstrzykn[ąa][ćc]|doda[ćc]))(?=\\s)\\s+${PL_SHORT}(?:(?:dodatkow\\S*|kolejn\\S*|jeszcze\\s+jedn\\S*)\\s+${PL_SHORT}${m.pl}|(?:jedn\\S*|dwie|dwa|trzy|\\d+)\\s+${PL_SHORT}${m.pl}\\s+więcej(?=[\\s.,;:!?]|$))`,
        "i",
      ),
    ],
    ko: [
      // A stated amount closed by an imperative or a recommendation, with or
      // without a target particle: "2000mg으로 증량하세요", "하루 2정 드세요".
      new RegExp(`${KO_TARGET}[^.?!]{0,25}${KO_IMPERATIVE}`, "i"),
      // A medication object halved, doubled, skipped or stopped by imperative.
      new RegExp(
        `${m.ko}[^.?!]{0,20}(?:(?:절반|반)\\s*으로\\s*(?:줄이|나누)(?:세요|십시오)|(?:절반|반)\\s*으로\\s*(?:줄여|나눠)\\s*(?:보세요|주세요)|두\\s?배로\\s*(?:늘리|올리)(?:세요|십시오)|두\\s?배로\\s*(?:늘려|올려)\\s*(?:보세요|주세요)|(?:건너뛰|중단하|끊으|멈추|그만\\s*드시|그만\\s*복용하)(?:세요|십시오))`,
      ),
      new RegExp(
        `(?:복용|투약|투여|주사)(?:을|를)?\\s*(?:중단하|멈추|그만하|끊으)(?:세요|십시오)`,
      ),
      // One more or an additional dose of a medication, closed by an
      // imperative: "라미프릴을 한 알 더 드세요", "인슐린을 추가로 맞으세요".
      // The prohibitive "더 드시지 마세요" never meets an imperative ending.
      new RegExp(
        `${m.ko}[^.?!]{0,12}(?:(?:(?:한|두|세|\\d+)\\s*(?:알|정|캡슐|번|단위)?\\s*)?더|추가로)\\s*(?:드세요|드십시오|복용하세요|복용하십시오|투여하세요|맞으세요|맞으십시오|주사하세요)`,
      ),
    ],
  };
}

/** The class with no schedule: dosage forms, class words and generic stems. */
const DOSE_CHANGE_CLASS = buildDoseChangeClass(medVocabulary(null));

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
  const built = buildDoseChangeClass(medVocabulary(names));
  if (NAMED_CLASS_CACHE.size >= NAMED_CLASS_CACHE_SIZE) {
    const oldest = NAMED_CLASS_CACHE.keys().next().value;
    if (oldest !== undefined) NAMED_CLASS_CACHE.delete(oldest);
  }
  NAMED_CLASS_CACHE.set(names, built);
  return built;
}

const DOSE_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    // step/move/increase/raise/bump/titrate/go up to|by N unit
    new RegExp(
      `\\b(?:step|move|increase|raise|bump|titrat\\w*|go|ramp|push|up)\\s+(?:it\\s+)?(?:up\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // lower/reduce/cut/drop/decrease/back off/taper(ing) to|by N unit
    new RegExp(
      `\\b(?:lower|reduce|cut|drop|decrease|back\\s+off|taper\\w*)\\s+(?:it\\s+|your\\s+dose\\s+)?(?:to|by)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // consider/try/should/recommend ... N unit
    new RegExp(
      `\\b(?:consider|try|you\\s+should|i'?d?\\s+recommend|i\\s+suggest)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // Experiment-shaped dose changes the "to/by N unit" patterns miss. BOTH a
    // medication object AND a trial cue are required, so a benign behavioural
    // experiment ("double your steps for two weeks") never trips.
    /\b(?:halv\w*|doubl\w*|skip\w*|stop\s+taking|quit\s+taking|come\s+off)\b[^.?!]{0,25}\b(?:dose|doses|pill|pills|tablet|tablets|medication|meds?|insulin|injection)\b[^.?!]{0,40}\b(?:for\s+\w+\s+(?:day|days|week|weeks|month|months)|to\s+(?:see|test|try|check)|next\s+(?:week|month))\b/i,
  ],
  de: [
    new RegExp(
      `\\b(?:erhöh\\w*|steiger\\w*|setz\\w*\\s+(?:hoch|rauf)|geh\\w*\\s+(?:hoch|rauf))${DE_DOSE_OBJECT}\\s+(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:reduzier\\w*|senk\\w*|verringer\\w*|nimm\\s+(?:weniger|runter))${DE_DOSE_OBJECT}\\s+(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\bn[äa]chste\\s+(?:stufe|dosis)\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // German puts the verb last in a subordinate clause ("auf 7,5 mg zu
    // erhöhen"), so the verb-first patterns above miss the most natural
    // phrasing of the instruction. Match the inverted order too.
    new RegExp(
      `\\b(?:auf|um)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}[^.?!]{0,30}\\b(?:erhöh\\S*|steiger\\S*|reduzier\\S*|senk\\S*|verringer\\S*|hochsetz\\S*)`,
      "i",
    ),
    new RegExp(
      `\\b(?:erwäg\\w*|probier\\w*|du\\s+solltest|ich\\s+empfehle|ich\\s+schlage\\s+vor)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    /\b(?:halbier\w*|verdoppel\w*|lass\w*\s+aus|setz\w*\s+ab|pausier\w*)\b[^.?!]{0,25}\b(?:dosis|tablette\w*|medikament\w*|spritze\w*|insulin)\b[^.?!]{0,40}\b(?:für\s+\w+\s+(?:tag|tage|woche|wochen|monat\w*)|um\s+zu\s+(?:sehen|testen)|zum\s+(?:test|ausprobieren))\b/i,
  ],
  fr: [
    // augmentez / montez / passez / portez à|de N unit
    new RegExp(
      `\\b(?:augment\\w*|mont\\w*|pass\\w*|port\\w*|majo\\w*)\\s+(?:votre\\s+dose\\s+)?(?:[àa]|de|jusqu'[àa])\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // réduisez / diminuez / baissez à|de N unit
    new RegExp(
      `\\b(?:r[ée]duis\\w*|r[ée]duire|diminu\\w*|baiss\\w*|abaiss\\w*)\\s+(?:votre\\s+dose\\s+)?(?:[àa]|de|jusqu'[àa])\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:envisagez|essayez|vous\\s+devriez|je\\s+recommande|je\\s+sugg[èe]re)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:prochaine|nouvelle)\\s+dose\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  es: [
    // aumente / suba / pase a|en N unit
    new RegExp(
      `\\b(?:aument\\w*|sub\\w*|pas\\w*|increment\\w*)\\s+(?:su\\s+dosis\\s+)?(?:a|en|hasta)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // reduzca / baje / disminuya a|en N unit
    new RegExp(
      `\\b(?:reduzc\\w*|reduc\\w*|baj\\w*|disminu\\w*)\\s+(?:su\\s+dosis\\s+)?(?:a|en|hasta)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:considere|pruebe|deber[íi]a|recomiendo|sugiero)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:pr[óo]xima|siguiente|nueva)\\s+dosis\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  it: [
    // aumenti / salga / passi a|di N unit
    new RegExp(
      `\\b(?:aument\\w*|sal\\w*|pass\\w*|increment\\w*)\\s+(?:la\\s+sua\\s+dose\\s+)?(?:a|di|fino\\s+a)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // riduca / abbassi / diminuisca a|di N unit
    new RegExp(
      `\\b(?:riduc\\w*|ridur\\w*|abbass\\w*|diminu\\w*|cal\\w*)\\s+(?:la\\s+sua\\s+dose\\s+)?(?:a|di|fino\\s+a)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:consideri|provi|dovrebbe|raccomando|suggerisco)\\b[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:prossima|nuova)\\s+dose\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ],
  pl: [
    // zwiększ / podnieś / przejdź do|o N unit
    new RegExp(
      `\\b(?:zwi[ęe]ksz\\S*|podnie[śs]\\S*|przejd[źz]\\S*|podwy[żz]sz\\S*)\\s+(?:dawk\\S*\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // zmniejsz / obniż / zredukuj do|o N unit
    new RegExp(
      `\\b(?:zmniejsz\\S*|obni[żz]\\S*|zreduk\\S*|reduk\\S*)\\s+(?:dawk\\S*\\s+)?(?:do|o)\\s+[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:rozwa[żz]\\S*|spr[óo]buj\\S*|powinien|powinna|zalecam|sugeruj[ęe])[^.?!]{0,40}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `\\b(?:nast[ęe]pna|kolejna|nowa)\\s+dawka\\b[^.?!]{0,30}\\b[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
  ], // Korean is verb-final: the dose comes first and the change verb closes the
  // clause ("2.4mg으로 늘려 보세요"), the mirror image of the Latin banks. A
  // target-marking particle on the dose is required, the same demand the Latin
  // banks make of "to" / "by" / "auf" — without it the permitted restatement
  // "7.5mg을 복용 중이고, 체중은 내려가고 있어요" matched the lowering pattern.
  ko: [
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}\\s*(?:으로|로|까지)[^.?!]{0,20}(?:올리|올려|늘리|늘려|증량|높이|높여|인상)`,
      "i",
    ),
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}\\s*(?:으로|로|까지)[^.?!]{0,20}(?:내리|내려|줄이|줄여|감량|낮추|낮춰|감축)`,
      "i",
    ),
    new RegExp(
      `(?:권해|권장|권고|추천|제안)[^.?!]{0,40}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    new RegExp(
      `[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}[^.?!]{0,40}(?:권해|권장|권고|추천|제안|드심|드셔|복용하세요|시도해)`,
      "i",
    ),
    new RegExp(
      `(?:다음|새)\\s*(?:용량|단계|복용량)[^.?!]{0,30}[\\d.,]+\\s*${DOSE_UNIT}${UNIT_END}`,
      "i",
    ),
    // Both a medication object AND a trial cue are required, as in the EN bank,
    // so "걸음 수를 두 배로 늘려 2주간 해보세요" never trips.
    /(?:약|알|정|인슐린|주사|복용|용량)[^.?!]{0,25}(?:절반|반으로|두\s?배|건너뛰|중단|끊)[^.?!]{0,40}(?:주간|주 동안|일 동안|달 동안|보세요|보십시오|보자|해 ?보)/,
  ],
};

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
// Spelled-out cardinal numbers (0–99) so a digit-less "twelve percent" still
// counts as a fabricated figure, not an educational aside.
const SPELLED_EN =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?";
const PCT_WORD_EN = `${SPELLED_EN}\\s+(?:percent|per\\s+cent)`;
const QUAL_NUM_EN = `(?:\\d{1,3}\\s*%|${PCT_WORD_EN}|score\\s+of\\s+\\d)`;
const RISK_NOUN_EN = "(?:risk|chance|probability|likelihood)";
const ENGINE = "(?:framingham|ascvd|score2|qrisk)";
const HORIZON_EN =
  "(?:10[- ]year|ten[- ]year|lifetime)\\s+(?:cardiovascular|cardiac|heart|stroke|mortality|cvd|ascvd)\\s+risk";
const RESULT_VERB_EN =
  "(?:puts?\\s+you|would\\s+put\\s+you|placing\\s+you|places?\\s+you|you\\s+fall|you'?d\\s+fall|classif\\w*\\s+you)";
const RISK_BAND_EN =
  "(?:high|higher|intermediate|elevated|moderate|low|borderline)[- ]?risk\\s+(?:band|category|group|range)";
// A categorical VERDICT on the engine / horizon itself ("your 10-year risk IS
// elevated") — a fabricated result with no digits. The horizon phrase and a
// named engine are inherently about-this-user, so an attached risk-level
// adjective is an assertion, not education. A model-perfect refusal names the
// horizon but attaches no such adjective, so it still passes.
const RISK_LEVEL_EN =
  "(?:elevated|high|higher|intermediate|moderate|borderline|raised|concerning|significant)";
const RISK_VERDICT_EN = `(?:is|are|looks?|appears?|seems?|sits?|remains?|comes?\\s+back|runs?|suggests?|indicat\\w*|shows?|reflects?|points?\\s+to)\\s+(?:\\w+\\s+){0,2}${RISK_LEVEL_EN}`;
const SPELLED_DE =
  "(?:null|eins?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig|dreißig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)";
const PCT_WORD_DE = `${SPELLED_DE}\\s+prozent`;
const QUAL_NUM_DE = `(?:\\d{1,3}\\s*%|${PCT_WORD_DE})`;
const RISK_NOUN_DE = "(?:risiko|wahrscheinlichkeit|chance)";
const HORIZON_DE = "(?:10[- ]jahres|zehn[- ]jahres|lebenszeit)[- ]?risiko";
const RESULT_VERB_DE =
  "(?:ordnet\\s+(?:dich|sie)\\s+ein|stuft\\s+(?:dich|sie)\\s+ein|f[äa]llst\\s+in|einordnen|liegst\\s+im)";
const RISK_BAND_DE =
  "(?:hoh|niedrig|mittler|erhöht|moderat|gering)\\w*[- ]?risiko(?:bereich|kategorie|gruppe|band)";
const RISK_LEVEL_DE =
  "(?:erhöht|hoch|höher|mittel|mäßig|grenzwertig|besorgniserregend|deutlich)";
const RISK_VERDICT_DE = `(?:ist|liegt|erscheint|wirkt|bleibt|zeigt|deutet\\s+auf|weist\\s+auf)\\s+(?:\\w+\\s+){0,2}${RISK_LEVEL_DE}`;

/*
 * v1.32.7 narrowed EN + DE only; v1.32.9 (Coach Guard II / B.6) brings fr / es
 * / it / pl to parity: a spelled-out percent counts as a fabricated figure, the
 * named engine blocks with a qualifying number in either order, and a
 * categorical engine RESULT ("SCORE2 vous met dans la tranche à haut risque")
 * blocks numberless. The digit-percent + horizon patterns each locale already
 * shipped stay. Spelled-out cardinals cover 0–19 + the tens a realistic risk
 * percentage uses.
 */
const SPELLED_FR =
  "(?:zéro|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix-sept|dix-huit|dix-neuf|vingt|trente|quarante|cinquante|soixante)";
const PCT_WORD_FR = `${SPELLED_FR}\\s+(?:pour\\s+cent|pour-cent)`;
const QUAL_NUM_FR = `(?:\\d{1,3}\\s*%|${PCT_WORD_FR})`;
const RISK_NOUN_FR = "(?:risque|probabilité|chance)";
const RESULT_VERB_FR =
  "(?:vous\\s+(?:met|place|situe|classe|met\\s+dans)|vous\\s+êtes\\s+(?:dans|classé)|vous\\s+tombez\\s+dans)";
const SPELLED_ES =
  "(?:cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciséis|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta)";
const PCT_WORD_ES = `${SPELLED_ES}\\s+por\\s+ciento`;
const QUAL_NUM_ES = `(?:\\d{1,3}\\s*%|${PCT_WORD_ES})`;
const RISK_NOUN_ES = "(?:riesgo|probabilidad)";
const RESULT_VERB_ES =
  "(?:lo\\s+(?:coloca|sitúa|clasifica|pone)|le\\s+(?:coloca|sitúa|clasifica)|se\\s+encuentra\\s+en|está\\s+en\\s+(?:la\\s+)?categor|cae\\s+en)";
const SPELLED_IT =
  "(?:zero|uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti|trenta|quaranta|cinquanta|sessanta)";
const PCT_WORD_IT = `${SPELLED_IT}\\s+per\\s+cento`;
const QUAL_NUM_IT = `(?:\\d{1,3}\\s*%|${PCT_WORD_IT})`;
const RISK_NOUN_IT = "(?:rischio|probabilità)";
const RESULT_VERB_IT =
  "(?:la\\s+(?:colloca|mette|classifica|pone)|rientra\\s+(?:in|nella)|si\\s+trova\\s+(?:in|nella)|ricade\\s+in)";
const SPELLED_PL =
  "(?:zero|jeden|dwa|trzy|cztery|pięć|sześć|siedem|osiem|dziewięć|dziesięć|jedenaście|dwanaście|trzynaście|czternaście|piętnaście|szesnaście|siedemnaście|osiemnaście|dziewiętnaście|dwadzieścia|trzydzieści|czterdzieści|pięćdziesiąt|sześćdziesiąt)";
const PCT_WORD_PL = `${SPELLED_PL}\\s+procent`;
const QUAL_NUM_PL = `(?:\\d{1,3}\\s*%|${PCT_WORD_PL})`;
const RISK_NOUN_PL = "(?:ryzyk\\w*|prawdopodobieństw\\w*)";
const RESULT_VERB_PL =
  "(?:umieszcza\\s+(?:cię|pana|panią)|klasyfikuje\\s+(?:cię|pana|panią)|znajdujesz\\s+się\\s+w|wpadasz\\s+w|kwalifikuje\\s+(?:cię|pana|panią))";

// Korean carries no `\\b` next to a Hangul token: `\\b` is an ASCII \\w boundary
// and Hangul is not \\w, so /\\b위험/ matches nothing. Spelled-out percentages are
// omitted deliberately — Korean writes "12%", and the Sino-Korean numerals
// ("이", "삼") collide with common particles.
const QUAL_NUM_KO = "(?:\\d{1,3}\\s*(?:%|퍼센트|프로))";
const RISK_NOUN_KO = "(?:위험(?:도|률|성)?|확률|가능성)";
const HORIZON_KO = "(?:10년|십\\s?년|평생)\\s*(?:위험(?:도|률)?|리스크)";
const RESULT_VERB_KO =
  "(?:(?:에|으로|로)\\s*(?:분류|해당|속하|들어가)|군에\\s*(?:속하|해당))";
const RISK_BAND_KO =
  "(?:고|중간|중등도|저|높은|낮은)\\s*위험\\s*(?:군|범위|등급|구간)";
const RISK_LEVEL_KO = "(?:높|상승|증가|중등도|경계|우려)";
const RISK_VERDICT_KO = `(?:은|는|이|가)\\s*[^.?!]{0,10}${RISK_LEVEL_KO}`;

const RISK_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    // (1) digit percent adjacent to a risk noun, either order
    new RegExp(`\\b\\d{1,3}\\s*%\\s+${RISK_NOUN_EN}\\b`, "i"),
    new RegExp(
      `\\b${RISK_NOUN_EN}\\s+(?:of|is|at|around|about|near|sits?\\s+at|would\\s+be)\\s+(?:about\\s+|roughly\\s+|approximately\\s+|around\\s+|~)?\\d{1,3}\\s*%`,
      "i",
    ),
    // (2) spelled-out percent as a risk figure, either order (D4b)
    new RegExp(`\\b${RISK_NOUN_EN}\\b[^.?!]{0,40}\\b${PCT_WORD_EN}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_EN}\\b[^.?!]{0,40}\\b${RISK_NOUN_EN}\\b`, "i"),
    // (3) 10-year horizon phrase + a qualifying number, either order (M4)
    new RegExp(`\\b${HORIZON_EN}\\b[^.?!]{0,40}${QUAL_NUM_EN}`, "i"),
    new RegExp(`${QUAL_NUM_EN}[^.?!]{0,40}\\b${HORIZON_EN}\\b`, "i"),
    // (4) named engine + a qualifying number, either order
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_EN}`, "i"),
    new RegExp(`${QUAL_NUM_EN}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    // (5) engine / horizon + a categorical RESULT assertion, numberless (D4)
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,60}${RESULT_VERB_EN}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,60}${RISK_BAND_EN}`,
      "i",
    ),
    // (6) engine / horizon + a categorical risk-level verdict, numberless
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_EN})\\b[^.?!]{0,40}${RISK_VERDICT_EN}`,
      "i",
    ),
  ],
  de: [
    new RegExp(
      `\\brisiko\\s+(?:von|bei|liegt\\s+bei)\\s+(?:etwa\\s+|ungefähr\\s+|~)?\\d{1,3}\\s*%`,
      "i",
    ),
    new RegExp(`\\b\\d{1,3}\\s*%\\s+${RISK_NOUN_DE}\\b`, "i"),
    // spelled-out percent as a risk figure, either order
    new RegExp(`\\b${RISK_NOUN_DE}\\b[^.?!]{0,40}\\b${PCT_WORD_DE}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_DE}\\b[^.?!]{0,40}\\b${RISK_NOUN_DE}\\b`, "i"),
    // 10-year horizon + a qualifying number, either order
    new RegExp(`\\b${HORIZON_DE}\\b[^.?!]{0,40}${QUAL_NUM_DE}`, "i"),
    new RegExp(`${QUAL_NUM_DE}[^.?!]{0,40}\\b${HORIZON_DE}\\b`, "i"),
    // named engine (same literals) + qualifying number or categorical result
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_DE}`, "i"),
    new RegExp(`${QUAL_NUM_DE}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_DE})\\b[^.?!]{0,60}${RESULT_VERB_DE}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_DE})\\b[^.?!]{0,60}${RISK_BAND_DE}`,
      "i",
    ),
    new RegExp(
      `\\b(?:${ENGINE}|${HORIZON_DE})\\b[^.?!]{0,40}${RISK_VERDICT_DE}`,
      "i",
    ),
  ],
  fr: [
    /\brisque\s+(?:est\s+)?(?:de\s+|d['’])?(?:environ\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:risque|probabilit[ée]|chance)/i,
    /\brisque\s+(?:cardiovasculaire|cardiaque|d'avc|de\s+mortalit[ée])\s+[àa]\s+(?:10|dix)\s+ans\b/i,
    // digit percent as a risk figure, either order (the noun need not be adjacent)
    new RegExp(`\\b${RISK_NOUN_FR}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_FR}\\b`, "i"),
    // spelled-out percent as a risk figure, either order
    new RegExp(`\\b${RISK_NOUN_FR}\\b[^.?!]{0,40}\\b${PCT_WORD_FR}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_FR}\\b[^.?!]{0,40}\\b${RISK_NOUN_FR}\\b`, "i"),
    // named engine + qualifying number, either order
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_FR}`, "i"),
    new RegExp(`${QUAL_NUM_FR}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    // engine + categorical result assertion, numberless
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_FR}`, "i"),
  ],
  es: [
    /\briesgo\s+(?:del?|es\s+del?|de\s+aproximadamente)\s+(?:aproximadamente\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:de\s+)?(?:riesgo|probabilidad)/i,
    /\briesgo\s+(?:cardiovascular|card[íi]aco|de\s+ictus|de\s+mortalidad)\s+a\s+(?:10|diez)\s+a[ñn]os\b/i,
    new RegExp(`\\b${RISK_NOUN_ES}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_ES}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_ES}\\b[^.?!]{0,40}\\b${PCT_WORD_ES}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_ES}\\b[^.?!]{0,40}\\b${RISK_NOUN_ES}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_ES}`, "i"),
    new RegExp(`${QUAL_NUM_ES}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_ES}`, "i"),
  ],
  it: [
    /\brischio\s+(?:del?|dell'|[èe]\s+del?|di\s+circa)\s+(?:circa\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:di\s+)?(?:rischio|probabilit[àa])/i,
    /\brischio\s+(?:cardiovascolare|cardiaco|di\s+ictus|di\s+mortalit[àa])\s+a\s+(?:10|dieci)\s+anni\b/i,
    new RegExp(`\\b${RISK_NOUN_IT}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_IT}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_IT}\\b[^.?!]{0,40}\\b${PCT_WORD_IT}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_IT}\\b[^.?!]{0,40}\\b${RISK_NOUN_IT}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_IT}`, "i"),
    new RegExp(`${QUAL_NUM_IT}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_IT}`, "i"),
  ],
  pl: [
    /\bryzyko\s+(?:wynosi\s+|około\s+|~)?\d{1,3}\s*%/i,
    /\b\d{1,3}\s*%\s+(?:ryzyka|prawdopodobie[ńn]stwa)/i,
    /\bryzyk\w*\s+(?:sercowo[- ]naczyniow\w*|zawału|udaru|zgonu)\s+w\s+(?:ci[ąa]gu\s+)?(?:10|dziesi[ęe]ciu)\s+lat\b/i,
    new RegExp(`\\b${RISK_NOUN_PL}\\b[^.?!]{0,40}\\d{1,3}\\s*%`, "i"),
    new RegExp(`\\d{1,3}\\s*%[^.?!]{0,40}\\b${RISK_NOUN_PL}\\b`, "i"),
    new RegExp(`\\b${RISK_NOUN_PL}\\b[^.?!]{0,40}\\b${PCT_WORD_PL}\\b`, "i"),
    new RegExp(`\\b${PCT_WORD_PL}\\b[^.?!]{0,40}\\b${RISK_NOUN_PL}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_PL}`, "i"),
    new RegExp(`${QUAL_NUM_PL}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,60}${RESULT_VERB_PL}`, "i"),
  ],
  ko: [
    new RegExp(`${RISK_NOUN_KO}[^.?!]{0,15}${QUAL_NUM_KO}`, "i"),
    new RegExp(`${QUAL_NUM_KO}[^.?!]{0,15}${RISK_NOUN_KO}`, "i"),
    new RegExp(`${HORIZON_KO}[^.?!]{0,40}${QUAL_NUM_KO}`, "i"),
    new RegExp(`${QUAL_NUM_KO}[^.?!]{0,40}${HORIZON_KO}`, "i"),
    new RegExp(`\\b${ENGINE}\\b[^.?!]{0,50}${QUAL_NUM_KO}`, "i"),
    new RegExp(`${QUAL_NUM_KO}[^.?!]{0,50}\\b${ENGINE}\\b`, "i"),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_KO})[^.?!]{0,60}${RESULT_VERB_KO}`,
      "i",
    ),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_KO})[^.?!]{0,60}${RISK_BAND_KO}`,
      "i",
    ),
    new RegExp(
      `(?:\\b${ENGINE}\\b|${HORIZON_KO})[^.?!]{0,40}${RISK_VERDICT_KO}`,
      "i",
    ),
  ],
};

/**
 * Causal-claim banks — GROUND RULE 12. Descriptive framing stays permitted
 * ("moved with", "was associated with", "assoziiert", "associé à"); only
 * asserted causation trips. This bank is enforced ONLY on the insights-family
 * surfaces the rule declares, never on the Coach.
 */
const CAUSAL_PATTERNS: Record<Locale, readonly RegExp[]> = {
  en: [
    /\bbecause\b/i,
    /\bcaused?\s+by\b/i,
    /\bcaus(?:e|es|ed|ing)\b/i,
    /\bdue\s+to\b/i,
    /\bled\s+to\b/i,
    /\bresulted\s+in\b/i,
    /\bresult\s+of\b/i,
    /\bculprit\b/i,
    /\bdriven\s+by\b/i,
    /\bthanks\s+to\b/i,
    /\bowing\s+to\b/i,
    /\bresponsible\s+for\b/i,
  ],
  de: [
    /\bweil\b/i,
    /\bwegen\b/i,
    /\bverursach\w*/i,
    /\baufgrund\b/i,
    /\bführt[e]?\s+zu\b/i,
    /\bdurch\s+\w+\s+(?:verursacht|ausgelöst)\b/i,
    /\bschuld\b/i,
    /\bauslöser\b/i,
    /\bverantwortlich\s+für\b/i,
  ],
  fr: [
    /\bparce\s+qu\w*/i,
    /\b[àa]\s+cause\s+de\b/i,
    /\bcaus(?:e|es|ent|é|ée)\b/i,
    /\ben\s+raison\s+de\b/i,
    /\bentra[îi]n\w*/i,
    /\ba\s+conduit\s+[àa]/i,
    /\bd[ûu]\s+[àa]/i,
    /\bresponsable\s+de\b/i,
    /\bgr[âa]ce\s+[àa]/i,
    /\bprovoqu\w*/i,
  ],
  es: [
    /\bporque\b/i,
    /\bdebido\s+a\b/i,
    /\ba\s+causa\s+de\b/i,
    /\bcaus(?:a|an|ó|ado)/i,
    /\bprovoc\w*/i,
    /\bllev[óo]\s+a\b/i,
    /\bresponsable\s+de\b/i,
    /\bgracias\s+a\b/i,
    /\bimpuls\w*\s+(?:por|el|la)\b/i,
  ],
  it: [
    /\bperch[ée]/i,
    /\ba\s+causa\s+di\b/i,
    /\bcaus(?:a|ano|ato|ata)\b/i,
    /\bprovoc\w*/i,
    /\bha\s+portato\s+a\b/i,
    /\bdovuto\s+a\b/i,
    /\bresponsabile\s+di\b/i,
    /\bgrazie\s+a\b/i,
    /\bguid\w*\s+da\b/i,
  ],
  pl: [
    /\bponiewa[żz]/i,
    /\bz\s+powodu\b/i,
    /\bpowoduj\w*/i,
    /\bspowodowa\w*/i,
    /\bprzyczyn\w*/i,
    /\bdoprowadzi\w*\s+do\b/i,
    /\bwskutek\b/i,
    /\bdzi[ęe]ki\b/i,
    /\bodpowiedzialn\w*\s+za\b/i,
  ],
  ko: [
    /때문(?:에|이)/,
    /(?:으로|로)\s*인(?:해|하여|한)/,
    /탓(?:에|이|으로)/,
    /(?:이|가)\s*원인/,
    /원인(?:은|이에요|입니다|이라|으로)/,
    /유발/,
    /초래/,
    /야기/,
    /덕분(?:에|이)/,
    /(?:영향을|결과로)\s*(?:줘서|줬|나타났|이어졌)/,
  ],
};

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
 * object ("keep taking … as prescribed") AND carries no change stem. So
 * "you should keep taking your prescribed 7.5 mg" passes, while
 * "you should keep in mind that trying 5 mg" (no maintenance anchor) and
 * "you should continue tapering to 2.4 mg" (a change stem present) stay
 * blocked. The direction is exclusion-of-continuation, never
 * requirement-of-change — "you should try 5 mg" must keep blocking.
 *
 * Accepted residual FP, failing safe: "I'd recommend discussing the 2.4 mg
 * step with your doctor" stays blocked ("step" is a change stem).
 */
const DOSE_CONTINUATION: Record<Locale, RegExp> = {
  en: /\b(?:keep\s+taking|keep\s+on\s+taking|continue\s+(?:taking|with|on)|stay(?:ing)?\s+(?:on|at)|remain(?:ing)?\s+on|as\s+prescribed|as\s+directed|as\s+usual|as\s+before|as\s+you\s+have\s+been)\b/i,
  de: /\b(?:weiterhin|weiter\s+(?:einnehmen|nehmen)|nimm\s+weiter|beibehalten|behalte\s+bei|wie\s+(?:verordnet|verschrieben|besprochen|gewohnt|bisher)|bleib(?:e|st)?\s+bei)\b/i,
  fr: /\b(?:continuez?\s+(?:à|de|le)|gardez|comme\s+prescrit|tel\s+que\s+prescrit)\b/i,
  es: /\b(?:siga\s+(?:tomando|con)|continúe|mantenga|según\s+lo\s+prescrito)\b/i,
  it: /\b(?:continui\s+(?:a|con|il)|mantenga|come\s+prescritto)\b/i,
  pl: /\b(?:kontynuuj|przyjmuj\s+dalej|zgodnie\s+z\s+zaleceniem|pozosta[ńn]\s+przy)\b/i,
  ko: /(?:그대로\s*(?:유지|복용)|계속\s*(?:복용|드시|유지)|처방(?:대로|받은\s*대로)|지시(?:대로|받은\s*대로)|유지하세요)/,
};

const DOSE_CHANGE_STEM: Record<Locale, RegExp> = {
  en: /\b(?:increas|reduc|taper|titrat|step\s+(?:up|down)|lower|raise|halv|doubl|skip|bump|ramp)\w*/i,
  de: /\b(?:erhöh|steiger|reduzier|senk|verringer|halbier|verdoppel|absetz|auslass|hochsetz|runtersetz|titrier)\w*/i,
  fr: /\b(?:augment|réduis|réduir|diminu|baiss|abaiss|doubl|arrêt|saut)\w*/i,
  es: /\b(?:aument|reduzc|reduc|baj|disminu|dobl|omit|salt)\w*/i,
  it: /\b(?:aument|riduc|ridur|abbass|diminu|raddoppi|salt|dimezz)\w*/i,
  pl: /\b(?:zwiększ|zmniejsz|obniż|podnie[śs]|podwyższ|zreduk|pomi[ńn]|opu[śs][ćc])\w*/i,
  ko: /(?:올리|올려|늘리|늘려|증량|높이|높여|인상|내리|내려|줄이|줄여|감량|낮추|낮춰|감축|절반|반으로|두\s?배|건너뛰|중단|끊)/,
};

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

/** True when a dose value matches a scheduled dose (exact / ±2%). */
function matchesSchedule(
  values: readonly number[],
  schedule: readonly number[],
): boolean {
  return values.some((v) =>
    schedule.some((s) => Math.abs(v - s) <= Math.max(0.01, Math.abs(s) * 0.02)),
  );
}

/**
 * True when a dose-change imperative trips, honouring the continuation rule.
 *
 * v1.32.9 (Coach Guard II / G3 — M6/D7 end state): when `scheduleDoses` is
 * supplied (the Coach passes the user's active doses), the continuation
 * exemption ALSO requires the sentence's dose to match one the user is actually
 * on. So "keep taking your 7.5 mg" passes only when 7.5 is a scheduled dose;
 * "keep taking your 15 mg" when the schedule says 7.5 is a wrong maintenance
 * dose and stays blocked. Without a schedule (every non-Coach surface) the
 * Guard I phrase-anchored exemption stands unchanged.
 */
function doseTrips(
  subject: string,
  locale: Locale,
  scheduleDoses?: readonly number[],
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
  const gateOnSchedule =
    scheduleDoses !== undefined && scheduleDoses.length > 0;
  for (const sentence of splitSentences(subject)) {
    if (!patterns.some((p) => p.test(sentence))) continue;
    let exempt =
      continuation.some((p) => p.test(sentence)) &&
      !changeStem.some((p) => p.test(sentence));
    if (exempt && gateOnSchedule) {
      // The continuation phrasing is only trusted when the dose it names is one
      // the user is actually on. An off-schedule maintenance dose is caught.
      exempt = matchesSchedule(sentenceDoseValues(sentence), scheduleDoses);
    }
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
   * v1.32.9 — the user's active medication doses (numeric magnitudes). When
   * present, the dose continuation exemption is additionally gated on a match:
   * a "keep taking your N mg" is trusted only when N is a scheduled dose. Only
   * the Coach passes this; every other surface keeps the phrase-anchored rule.
   */
  scheduleDoses?: readonly number[];
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
      if (
        doseTrips(subject, locale, opts?.scheduleDoses, opts?.medicationNames)
      ) {
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
