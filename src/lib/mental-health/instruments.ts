/**
 * v1.25 — validated mental-health screener definitions (PHQ-9 + GAD-7).
 * v1.27.9 — the registry generalises to carry the WHO-5 well-being index and
 * the Sleep Condition Indicator (SCI) on the same infrastructure: per-item
 * answer scales, response-option schemes, score direction, and the reported
 * total (WHO-5 reports raw-sum × 4 as a 0–100 percentage) are now instrument
 * properties instead of PHQ/GAD assumptions.
 *
 * Pure, server-authoritative scoring. Item wording, response anchors, scoring
 * and band thresholds are taken from the primary sources only:
 *   - PHQ-9: Kroenke 2001; GAD-7: Spitzer 2006 (public-domain Pfizer grant).
 *   - WHO-5: WHO/UCN/MSD/MHE/2024.1 (© WHO 2024, CC BY-NC-SA 3.0 IGO) — raw
 *     0–25, × 4 → 0–100; "a percentage score below 50 … an indication for
 *     further assessment".
 *   - SCI: Espie et al., BMJ Open 2014;4:e004183 (© Sleepio Ltd, licensed
 *     free for non-commercial use, CC BY-NC) — 8 items, 0–4 each, total 0–32,
 *     HIGHER = better sleep; "a score of ≤16 … seems reasonable to detect
 *     possible insomnia disorder".
 * This module owns the canonical NUMERIC contract. The wording, per
 * instrument and language with its source, lives in `./wording/` and is read
 * through `instrument-wording.ts`; it never lives in `messages/*.json`.
 *
 * PHQ-9 item 9 (index 8) is the passive self-harm ideation screen and is the
 * safety-critical field (see `crisis-resources.ts` + the API handler): any
 * non-zero answer triggers a calm, non-alarmist crisis-resource signpost.
 * Neither the WHO-5 (all items positively worded) nor the SCI (sleep-specific
 * items only) carries a crisis item. The raw item answers are NEVER exposed
 * to the Coach / Insights / export surfaces — only the derived total score
 * rides a `*_SCORE` Measurement row.
 */

export type InstrumentId = "PHQ9" | "GAD7" | "WHO5" | "SCI";

export interface InstrumentDefinition {
  id: InstrumentId;
  /** Lowercase slug — the key segment of the app's own copy under `mentalHealth.*`. */
  i18nKey: "phq9" | "gad7" | "who5" | "sci";
  /** Number of scored items (PHQ-9 = 9, GAD-7 = 7, WHO-5 = 5, SCI = 8). */
  itemCount: number;
  /** Highest per-item answer value (PHQ/GAD 3, SCI 4, WHO-5 5). */
  itemMax: number;
  /**
   * Answer values in the order the source instrument presents them. The
   * PHQ/GAD forms run 0→3; the WHO-5 form leads with 5 ("All of the time");
   * the SCI form leads with 4.
   */
  optionOrder: readonly number[];
  /**
   * Item-specific anchor groups (SCI), one per item, naming the anchor set in
   * the wording's `anchors`. Without it every item uses the single set `all`.
   */
  optionGroups?: readonly string[];
  /**
   * Stem id per item, naming the text in the wording's `stems`: the question
   * the source form prints above its items (the PHQ-9 / GAD-7 "Over the last
   * 2 weeks…", the WHO-5 "Over the last two weeks …", the SCI section stems).
   * The wizard keeps it visible above every item.
   */
  stemIds: readonly string[];
  /** Multiplier from item-sum to the reported total (WHO-5: × 4). */
  scoreMultiplier: number;
  /** Inclusive REPORTED total range (WHO-5: 0–100 percentage). */
  minScore: number;
  maxScore: number;
  /** Whether a HIGHER total is the good direction (WHO-5 / SCI). */
  higherIsBetter: boolean;
  /** Total-score LOINC for the FHIR/export contract; null when none exists. */
  totalLoinc: string | null;
  /** Severity bands, ordered low→high. `min`/`max` inclusive over the total. */
  bands: ReadonlyArray<{ key: string; min: number; max: number }>;
  /**
   * Follow-up threshold on the reported scale. The concerning side follows
   * the direction: PHQ/GAD ≥ threshold, WHO-5/SCI ≤ threshold (WHO-5 "below
   * 50" — 50 itself is unreachable on the ×4 scale; SCI ≤ 16 per Espie 2014).
   */
  actionThreshold: number;
  /** Item index (0-based) of the safety-critical self-harm item, or null. */
  safetyItemIndex: number | null;
  /**
   * Required attribution — render VERBATIM on the instrument's start card and
   * the result view (and in exports). Stays in English by convention (the
   * developers' names and licence identifiers are not translated).
   */
  attribution: string;
}

/**
 * The PHQ family is public-domain (Pfizer 2010); this is the canonical footer
 * text per the instrument's own permission grant.
 */
const PHQ_GAD_ATTRIBUTION =
  "Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and " +
  "colleagues, with an educational grant from Pfizer Inc. No permission " +
  "required to reproduce, translate, display or distribute.";

const PHQ9: InstrumentDefinition = {
  id: "PHQ9",
  i18nKey: "phq9",
  itemCount: 9,
  itemMax: 3,
  optionOrder: [0, 1, 2, 3],
  scoreMultiplier: 1,
  minScore: 0,
  maxScore: 27,
  higherIsBetter: false,
  totalLoinc: "44261-6",
  bands: [
    { key: "minimal", min: 0, max: 4 },
    { key: "mild", min: 5, max: 9 },
    { key: "moderate", min: 10, max: 14 },
    { key: "modSevere", min: 15, max: 19 },
    { key: "severe", min: 20, max: 27 },
  ],
  // The form's own question, "Over the last 2 weeks, how often have you been
  // bothered by any of the following problems?", stands above every item.
  stemIds: Array(9).fill("period"),
  actionThreshold: 10,
  // Item 9 ("Thoughts that you would be better off dead…") — the safety field.
  safetyItemIndex: 8,
  attribution: PHQ_GAD_ATTRIBUTION,
};

const GAD7: InstrumentDefinition = {
  id: "GAD7",
  i18nKey: "gad7",
  itemCount: 7,
  itemMax: 3,
  optionOrder: [0, 1, 2, 3],
  stemIds: Array(7).fill("period"),
  scoreMultiplier: 1,
  minScore: 0,
  maxScore: 21,
  higherIsBetter: false,
  totalLoinc: "70274-6",
  bands: [
    { key: "minimal", min: 0, max: 4 },
    { key: "mild", min: 5, max: 9 },
    { key: "moderate", min: 10, max: 14 },
    { key: "severe", min: 15, max: 21 },
  ],
  actionThreshold: 10,
  safetyItemIndex: null,
  attribution: PHQ_GAD_ATTRIBUTION,
};

/**
 * WHO-5 well-being index — five positively-worded items over the last two
 * weeks, 6-point 5→0 scale. Reported score = raw sum × 4 (0–100, higher =
 * better well-being) per the official WHO scoring. "A percentage score below
 * 50 … has been suggested as a cut-off for poor mental well-being and as an
 * indication for further assessment" (WHO/UCN/MSD/MHE/2024.1) — the result
 * view answers a ≤ 50 total with a gentle pointer to the PHQ-9 check-in.
 * Achievable totals are multiples of 4, so the 0–50 band equals "below 50".
 */
const WHO5: InstrumentDefinition = {
  id: "WHO5",
  i18nKey: "who5",
  itemCount: 5,
  itemMax: 5,
  optionOrder: [5, 4, 3, 2, 1, 0],
  stemIds: Array(5).fill("period"),
  scoreMultiplier: 4,
  minScore: 0,
  maxScore: 100,
  higherIsBetter: true,
  totalLoinc: null,
  bands: [
    { key: "low", min: 0, max: 50 },
    { key: "good", min: 51, max: 100 },
  ],
  actionThreshold: 50,
  safetyItemIndex: null,
  attribution:
    "World Health Organization. The World Health Organization-Five Well-Being " +
    "Index (WHO-5). Geneva: World Health Organization; 2024. Licence: " +
    "CC BY-NC-SA 3.0 IGO. WHO does not endorse this application.",
};

/**
 * Sleep Condition Indicator — eight DSM-5-aligned items, 0–4 each with
 * item-specific anchors, total 0–32, HIGHER = better sleep. "A score of ≤16
 * on the SCI seems reasonable to detect possible insomnia disorder" (Espie
 * et al. 2014) — the band wording stays neutral per the paper, no diagnosis
 * language. Items 1–4 ask about a typical night in the last month, items 5–7
 * about the past month's daytime impact, item 8 about problem duration.
 */
const SCI: InstrumentDefinition = {
  id: "SCI",
  i18nKey: "sci",
  itemCount: 8,
  itemMax: 4,
  optionOrder: [4, 3, 2, 1, 0],
  optionGroups: [
    "duration",
    "duration",
    "nights",
    "quality",
    "impact",
    "impact",
    "impact",
    "problemDuration",
  ],
  stemIds: [
    "night",
    "night",
    "night",
    "night",
    "impact",
    "impact",
    "impact",
    "finally",
  ],
  scoreMultiplier: 1,
  minScore: 0,
  maxScore: 32,
  higherIsBetter: true,
  totalLoinc: null,
  bands: [
    { key: "belowThreshold", min: 0, max: 16 },
    { key: "aboveThreshold", min: 17, max: 32 },
  ],
  actionThreshold: 16,
  safetyItemIndex: null,
  attribution:
    "Espie CA, Kyle SD, Hames P, et al. The Sleep Condition Indicator: a " +
    "clinical screening tool to evaluate insomnia disorder. BMJ Open " +
    "2014;4:e004183. © Sleepio Limited; free for non-commercial use (CC BY-NC).",
};

export const INSTRUMENTS: Record<InstrumentId, InstrumentDefinition> = {
  PHQ9,
  GAD7,
  WHO5,
  SCI,
};

/** Landing / history ordering — the shipped pair first, then the new pair. */
export const INSTRUMENT_ORDER: readonly InstrumentId[] = [
  "PHQ9",
  "GAD7",
  "WHO5",
  "SCI",
];

/** The DB MeasurementType the instrument's total score projects to. */
export const INSTRUMENT_MEASUREMENT_TYPE: Record<InstrumentId, string> = {
  PHQ9: "PHQ9_SCORE",
  GAD7: "GAD7_SCORE",
  WHO5: "WHO5_SCORE",
  SCI: "SCI_SCORE",
};

/**
 * The REPORTED total for a completed administration (server-authoritative):
 * item-sum × the instrument's multiplier (WHO-5 reports the 0–100 percentage,
 * everything else the raw sum).
 */
export function scoreTotal(id: InstrumentId, items: readonly number[]): number {
  const sum = items.reduce((acc, v) => acc + v, 0);
  return sum * INSTRUMENTS[id].scoreMultiplier;
}

/** Resolve the severity-band key for a reported total score. */
export function severityBand(id: InstrumentId, total: number): string {
  const def = INSTRUMENTS[id];
  const band = def.bands.find((b) => total >= b.min && total <= b.max);
  // Defensive clamp — the API validates the total is in-range before this runs.
  return band?.key ?? def.bands[def.bands.length - 1].key;
}

/**
 * Whether the gentle follow-up hint applies for a reported total. Direction-
 * aware: PHQ-9/GAD-7 point up (≥ 10), WHO-5 and the SCI point down (≤ 50 /
 * ≤ 16 — lower totals mean lower well-being / worse sleep).
 */
export function needsFollowUp(id: InstrumentId, total: number): boolean {
  const def = INSTRUMENTS[id];
  return def.higherIsBetter
    ? total <= def.actionThreshold
    : total >= def.actionThreshold;
}

/**
 * Whether the safety signpost must be shown for these answers. True iff the
 * instrument has a safety item and that item was answered with any non-zero
 * value — independent of the total score (item 9 is never gated by the band).
 */
export function isSafetyFlagged(
  id: InstrumentId,
  items: readonly number[],
): boolean {
  const idx = INSTRUMENTS[id].safetyItemIndex;
  if (idx === null) return false;
  return (items[idx] ?? 0) > 0;
}

// ── AUDIT-C (v1.43, #614) ────────────────────────────────────────────────────
//
// The first three questions of the WHO AUDIT, served verbatim by
// `GET /api/anamnesis/life-circumstances` (`auditC.instrument`) so the web and
// the app render one wording. Not part of `INSTRUMENTS`: AUDIT-C is stored
// beside the screeners but never listed or scored by a mental-health surface
// (older app builds decode that instrument list closed). Scoring and the
// national cut-offs live in `audit-c.ts`.
//
// Licence: "As a WHO-approved instrument, the AUDIT is in the public domain"
// (auditscreen.org FAQ); reproduction is free as long as the wording is not
// materially changed and the WHO note is shown. Adapting the standard drink to
// the country is foreseen by the WHO manual, which is why that sentence is
// help text per language and not part of the items.
//
// Wording is taken from primary sources only. A language without a verified,
// published validated translation ships the WHO English original with
// `validatedLocale: false`, never a translation of our own:
//  - en: Babor et al., AUDIT manual, WHO/MSD/MSB/01.6a (2001), Box 4.
//        https://www.paho.org/sites/default/files/Auditmanual_ENG.pdf
//  - de: AUDIT Lübeck (Rumpf et al.), the version attached to the German S3
//        guideline (AWMF 076-001), as distributed on auditscreen.org:
//        https://auditscreen.org/cmsb/uploads/audit-german-l-beck.pdf
//        (the guideline PDF's own annex misprints item 2 as "7 oder 8", so
//        the Lübeck sheet is the one reproduced).
//  - ko: AUDIT-KR, Kim CG, Kim JS et al., Korean J Fam Med 2014;35:2-10,
//        Appendix 1. https://www.kjfm.or.kr/upload/pdf/kjfm-35-2.pdf
//        Item 2 prints two answer rows (soju bottles and standard glasses of
//        other drinks); each option carries both, in the source's order. Item 3
//        uses the Korean threshold (more than one bottle of soju, or five
//        standard glasses), which the KNHANES cut-offs were set against.
//  - pl: Klimkiewicz A et al., "Psychometric properties of the Polish version
//        of the AUDIT", Drug Alcohol Depend 2021; interview form as published
//        on auditscreen.org:
//        https://auditscreen.org/cmsb/uploads/audit_-polish_-interview_new.pdf
//  - es, fr, it: English with `validatedLocale: false`. Published official
//        wordings exist (WHO manual in Spanish; HAS 2023 guide in French; an
//        ISS leaflet in Italian), but no validation paper for them was read
//        and the Spanish and Italian sources carry misprints in the options.
//        Enabling one needs the wording read from its validation source.

export const AUDIT_C_ATTRIBUTION =
  "As a WHO-approved instrument, the AUDIT is in the public domain.";

interface AuditCItemWording {
  stem: string;
  /** Answer labels in score order, 0 to 4. */
  options: readonly [string, string, string, string, string];
}

interface AuditCWording {
  locale: string;
  items: readonly [AuditCItemWording, AuditCItemWording, AuditCItemWording];
}

/** Validated item wording by language. A language missing here renders `en`. */
export const AUDIT_C_ITEMS: Readonly<Record<string, AuditCWording>> = {
  en: {
    locale: "en",
    items: [
      {
        stem: "How often do you have a drink containing alcohol?",
        options: [
          "Never",
          "Monthly or less",
          "2 to 4 times a month",
          "2 to 3 times a week",
          "4 or more times a week",
        ],
      },
      {
        stem: "How many drinks containing alcohol do you have on a typical day when you are drinking?",
        options: ["1 or 2", "3 or 4", "5 or 6", "7, 8, or 9", "10 or more"],
      },
      {
        stem: "How often do you have six or more drinks on one occasion?",
        options: [
          "Never",
          "Less than monthly",
          "Monthly",
          "Weekly",
          "Daily or almost daily",
        ],
      },
    ],
  },
  de: {
    locale: "de",
    items: [
      {
        stem: "Wie oft nehmen Sie ein alkoholisches Getränk zu sich?",
        options: [
          "Niemals",
          "1 mal im Monat oder seltener",
          "2 bis 4 mal im Monat",
          "2 bis 3 mal pro Woche",
          "4 mal oder mehrmals in der Woche",
        ],
      },
      {
        stem: "Wenn Sie alkoholische Getränke zu sich nehmen, wieviel trinken Sie dann typischerweise an einem Tag?",
        options: ["1 - 2", "3 - 4", "5 - 6", "7 - 9", "10 oder mehr"],
      },
      {
        stem: "Wie oft trinken Sie 6 oder mehr Gläser Alkohol bei einer Gelegenheit?",
        options: [
          "Niemals",
          "Seltener als 1 mal im Monat",
          "1 mal im Monat",
          "1 mal pro Woche",
          "Täglich oder fast täglich",
        ],
      },
    ],
  },
  ko: {
    locale: "ko",
    items: [
      {
        stem: "술을 마시는 횟수는 어느 정도입니까?",
        options: [
          "전혀 안 마신다",
          "한 달에 1회 이하",
          "한 달에 2–4회",
          "일주일에 2–3회",
          "일주일에 4회 이상",
        ],
      },
      {
        stem: "술을 마시는 날은 보통 어느 정도를 마십니까?",
        options: [
          "소주: 반 병 이하 / 기타 술: 1–2잔",
          "소주: 1병 이하 / 기타 술: 3–4잔",
          "소주: 1.5병 정도 / 기타 술: 5–6잔",
          "소주: 2병 정도 / 기타 술: 7–9잔",
          "소주: 2.5병 이상 / 기타 술: 10잔 이상",
        ],
      },
      {
        stem: "한 번의 술좌석에서 소주 1병을 초과해서 마시는 횟수는 어느 정도입니까?(기타 술은 표준 5잔 이상)",
        options: [
          "전혀 없다",
          "한 달에 1회 미만",
          "한 달에 1회정도",
          "일주일에 1회 정도",
          "거의 매일",
        ],
      },
    ],
  },
  pl: {
    locale: "pl",
    items: [
      {
        stem: "Jak często pije Pani/Pan napoje zawierające alkohol?",
        options: [
          "nigdy",
          "raz w miesiącu lub rzadziej",
          "2 do 4 razy w miesiącu",
          "2 do 3 razy w tygodniu",
          "4 razy w tygodniu lub częściej",
        ],
      },
      {
        stem: "Ile standardowych porcji alkoholu wypija Pani/Pan podczas typowego dnia, w którym spożywa Pani/Pan alkohol?",
        options: [
          "1 lub 2",
          "3 lub 4",
          "5 lub 6",
          "7, 8 lub 9",
          "10 lub więcej",
        ],
      },
      {
        stem: "Jak często wypija Pani/Pan sześć lub więcej porcji alkoholu przy jednej okazji?",
        options: [
          "nigdy",
          "rzadziej niż raz w miesiącu",
          "raz w miesiącu",
          "raz w tygodniu",
          "codziennie lub prawie codziennie",
        ],
      },
    ],
  },
};

/**
 * One sentence on what counts as one drink, in each app language. Help text,
 * not part of the validated items. German and French follow their national
 * sources (alkoholleitlinie.de: about 10 to 12 g; HAS: 10 g), Korean quotes
 * the AUDIT-KR footnote, and the languages that show the English items use
 * the WHO manual's 10 g so the note matches the wording beside it.
 */
export const AUDIT_C_STANDARD_DRINK: Readonly<Record<string, string>> = {
  en: "One drink means a standard drink of about 10 g of pure alcohol, for example 330 ml of beer at 5%, 140 ml of wine at 12% or 40 ml of spirits at 40%.",
  de: "Ein Glas Alkohol entspricht etwa 10 bis 12 g reinem Alkohol, zum Beispiel 0,25 l Bier, 0,125 l Wein oder Sekt oder 4 cl Spirituosen.",
  es: "Una bebida equivale a una bebida estándar de unos 10 g de alcohol puro, la definición de la OMS que siguen estas preguntas.",
  fr: "Un verre standard contient 10 g d'alcool pur, par exemple 25 cl de bière à 5°, 10 cl de vin à 12° ou 3 cl d'alcool à 40°.",
  it: "Una bevanda corrisponde a una bevanda standard di circa 10 g di alcol puro, la definizione dell'OMS su cui si basano queste domande.",
  pl: "Standardowa porcja alkoholu to około 10 g czystego alkoholu, zgodnie z definicją WHO, na której opierają się te pytania.",
  nl: "Eén drankje is een standaardglas met ongeveer 10 g pure alcohol, de WHO-definitie waarop deze vragen gebaseerd zijn.",
  "pt-BR":
    "Uma bebida corresponde a uma dose padrão de cerca de 10 g de álcool puro, a definição da OMS na qual estas perguntas se baseiam.",
  ko: "표준 1잔: 양주잔으로 양주 1잔, 와인잔으로 와인 1잔, 막걸리 1사발이 각각 표준 1잔이다. 맥주는 캔맥주 1캔 또는 작은 병맥주 1병이며 생맥주는 500 mL가 표준 1잔이다. 소주는 1/4병이 표준 1잔에 해당한다.",
};
