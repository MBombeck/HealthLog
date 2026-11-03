/**
 * v1.18.8 — common lab biomarker → LOINC + canonical UCUM mapping.
 *
 * The lab-result `analyte` and `unit` are user free-text (no closed enum), so
 * the FHIR exporter has historically emitted a text-only `code` with a
 * display-only `unit` — honest about what it could validate. This module
 * closes the gap WITHOUT over-asserting: a curated map of the COMMON
 * biomarkers the app and docs surface (the demo's 9-biomarker panel + the
 * usual lipid / metabolic / liver / kidney / inflammation set). An analyte
 * that resolves here gets a real LOINC `coding` ALONGSIDE the user's
 * `code.text`, and the canonical UCUM `code` on the value WHEN the recorded
 * unit matches (or normalises to) the mapped canonical symbol. An analyte
 * that does NOT resolve keeps the exact pre-v1.18.8 text-only + unit-display
 * behaviour — no fabricated terminology.
 *
 * Conservative by design: only biomarkers whose LOINC term is well-established
 * are included. When in doubt, a biomarker is left OUT (text-only stays the
 * honest default) rather than guessed.
 *
 * Systems:
 *   LOINC — http://loinc.org
 *   UCUM  — http://unitsofmeasure.org
 *
 * FORWARD-COMPAT (v1.19.0 Biomarker catalog): the schema has a planned
 * user-scoped `Biomarker` catalog (`LabResult.biomarkerId`, NULL today). Once
 * a backfill links rows to a canonical analyte + unit, the resolved canonical
 * name should drive this lookup AHEAD of the raw free-text. `resolveLabCoding`
 * therefore accepts an optional `canonicalName` (the catalog's resolved name)
 * which takes precedence over the free-text `analyte`; the lab DTO does not
 * yet carry that field, so the call site passes only `analyte` today. When the
 * DTO gains a `biomarkerCanonicalName` (or similar), thread it in — no other
 * change to this module is required.
 *
 * SERVER-ONLY since the localised alias index landed: the index reads every
 * shipped message bundle through `@/lib/i18n/shared-resolve`. The single
 * caller is the FHIR exporter, which runs on the server; a client that needs
 * to show a biomarker's name resolves it through the labs catalog instead.
 */

import { localisedValues } from "@/lib/i18n/shared-resolve";
import { stripDiacritics } from "@/lib/i18n/fold-for-match";

/** A curated biomarker → LOINC + canonical-UCUM entry. */
export interface LabLoincMapping {
  loinc: string;
  display: string;
  /** Canonical UCUM symbol for this biomarker's value. */
  ucum: string;
}

/**
 * Normalise an analyte / unit string to a lookup key: lower-case, drop
 * accents, strip every character that is not a letter or digit. So "LDL-C",
 * "LDL Cholesterol", "ldl_c" all fold to `ldlc`-ish keys.
 *
 * The accent fold is what lets a name carrying diacritics reach a key at all.
 * Without it "Cholestérol total" lost its "é" entirely and folded to
 * `cholestroltotal`, and "Hämoglobin" to `hmoglobin` — keys nothing was ever
 * going to match, which is also why the hand-written German aliases below are
 * spelled `hamoglobin` and `kreatinin` rather than as the language writes
 * them. Every pre-existing alias is pure ASCII, so folding is a widening: what
 * resolved before resolves to the same key now.
 */
export function normaliseLabKey(s: string): string {
  // Hangul syllables are kept alongside the ASCII range: stripping to
  // [a-z0-9] alone reduced every Korean analyte name to the empty string, so
  // `buildLocalisedAliases` indexed none of them and no Korean label resolved.
  return stripDiacritics(s.toLowerCase()).replace(/[^a-z0-9а-яё가-힣]/g, "");
}

/**
 * Curated map keyed by the CANONICAL normalised analyte key. Aliases (below)
 * fold the many ways a user can spell a biomarker onto these keys. Each entry
 * is a well-established LOINC term with the conventional canonical UCUM unit.
 */
const LAB_LOINC_BY_KEY: Record<string, LabLoincMapping> = {
  hba1c: {
    loinc: "4548-4",
    display: "Hemoglobin A1c/Hemoglobin.total in Blood",
    ucum: "%",
  },
  // Method-less LDL: a recorded value does not say whether it was measured
  // directly (18262-6) or calculated (13457-7).
  ldlc: {
    loinc: "2089-1",
    display: "Cholesterol in LDL [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  hdlc: {
    loinc: "2085-9",
    display: "Cholesterol in HDL [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  cholesterol: {
    loinc: "2093-3",
    display: "Cholesterol [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  triglycerides: {
    loinc: "2571-8",
    display: "Triglyceride [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  ferritin: {
    loinc: "2276-4",
    display: "Ferritin [Mass/volume] in Serum or Plasma",
    ucum: "ug/L",
  },
  tsh: {
    loinc: "3016-3",
    display: "Thyrotropin [Units/volume] in Serum or Plasma",
    ucum: "m[IU]/L",
  },
  // Total 25-OH vitamin D (D2+D3), the value labs report; 1989-3 is D3 alone.
  vitamind: {
    loinc: "62292-8",
    display:
      "25-Hydroxyvitamin D3+25-Hydroxyvitamin D2 [Mass/volume] in Serum or Plasma",
    ucum: "ng/mL",
  },
  creatinine: {
    loinc: "2160-0",
    display: "Creatinine [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  // Formula-less eGFR per 1.73 m2. A recorded value does not name its
  // formula, and 33914-3 (MDRD) is DISCOURAGED in LOINC.
  egfr: {
    loinc: "69405-9",
    display:
      "Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by based on 1.73 sq M",
    ucum: "mL/min/{1.73_m2}",
  },
  alt: {
    loinc: "1742-6",
    display:
      "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
    ucum: "U/L",
  },
  ast: {
    loinc: "1920-8",
    display:
      "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma",
    ucum: "U/L",
  },
  crp: {
    loinc: "1988-5",
    display: "C reactive protein [Mass/volume] in Serum or Plasma",
    ucum: "mg/L",
  },
  glucosefasting: {
    loinc: "1558-6",
    display: "Fasting glucose [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  hemoglobin: {
    loinc: "718-7",
    display: "Hemoglobin [Mass/volume] in Blood",
    ucum: "g/dL",
  },
  // ── v1.25 — longevity lab panel additions (loinc.org confirmed this pass) ──
  apob: {
    loinc: "1884-6",
    display: "Apolipoprotein B [Mass/volume] in Serum or Plasma",
    ucum: "mg/dL",
  },
  lpa: {
    loinc: "43583-4",
    display: "Lipoprotein a [Moles/volume] in Serum or Plasma",
    ucum: "nmol/L",
  },
  hscrp: {
    loinc: "30522-7",
    display:
      "C reactive protein [Mass/volume] in Serum or Plasma by High sensitivity method",
    ucum: "mg/L",
  },
  ggt: {
    loinc: "2324-2",
    display:
      "Gamma glutamyl transferase [Enzymatic activity/volume] in Serum or Plasma",
    ucum: "U/L",
  },
  fastinginsulin: {
    loinc: "27873-9",
    display: "Insulin [Units/volume] in Serum or Plasma --fasting",
    ucum: "u[IU]/mL",
  },
  // NOTE(NEEDS-VERIFY): the RBC omega-3 index has no confirmed LOINC this pass
  // — it intentionally falls back to a local text-only concept on export.
};

/**
 * Alias → canonical key, hand-written. The LEFT side is the normalised form of
 * a name a user might type; the RIGHT side is a key in `LAB_LOINC_BY_KEY`.
 * Every canonical key is also implicitly its own alias (looked up directly
 * first). Keep the right side honest — only fold a synonym when it
 * unambiguously names the same analyte.
 *
 * This table covers spellings the app owns NO string for: clinical
 * abbreviations ("GPT", "ASAT", "hgb"), and the ways a person shortens a name
 * by hand. The NAMES the app itself displays are not transcribed here — see
 * the derived index below — because that list exists in six languages already
 * and copying it in would freeze it at today's six.
 */
const LAB_ALIASES: Record<string, string> = {
  // HbA1c
  a1c: "hba1c",
  glycatedhemoglobin: "hba1c",
  glycohemoglobin: "hba1c",
  hbalc: "hba1c",
  // LDL
  ldl: "ldlc",
  ldlcholesterol: "ldlc",
  ldlchol: "ldlc",
  // HDL
  hdl: "hdlc",
  hdlcholesterol: "hdlc",
  hdlchol: "hdlc",
  // Total cholesterol
  totalcholesterol: "cholesterol",
  cholesterintotal: "cholesterol",
  gesamtcholesterin: "cholesterol",
  chol: "cholesterol",
  // Triglycerides
  triglyceride: "triglycerides",
  trig: "triglycerides",
  triglyceride2: "triglycerides",
  tg: "triglycerides",
  // TSH
  thyrotropin: "tsh",
  thyroidstimulatinghormone: "tsh",
  // Vitamin D
  vitd: "vitamind",
  vit25ohd: "vitamind",
  "25ohd": "vitamind",
  "25hydroxyvitamind": "vitamind",
  vitamind3: "vitamind",
  // Creatinine
  kreatinin: "creatinine",
  creat: "creatinine",
  // eGFR
  gfr: "egfr",
  estimatedgfr: "egfr",
  // ALT
  gpt: "alt",
  alat: "alt",
  alaninetransaminase: "alt",
  // AST
  got: "ast",
  asat: "ast",
  aspartatetransaminase: "ast",
  // CRP
  creactiveprotein: "crp",
  // Fasting glucose
  fastingglucose: "glucosefasting",
  glucosefast: "glucosefasting",
  nuchternglucose: "glucosefasting",
  // Hemoglobin
  haemoglobin: "hemoglobin",
  hb: "hemoglobin",
  hgb: "hemoglobin",
  hamoglobin: "hemoglobin",
  // ── v1.25 — longevity lab panel aliases ──
  apolipoproteinb: "apob",
  apolipoprotein: "apob",
  lipoproteina: "lpa",
  lpkleina: "lpa",
  hscrp: "hscrp",
  highsensitivitycrp: "hscrp",
  hochsensitivescrp: "hscrp",
  gammagt: "ggt",
  gammaglutamyltransferase: "ggt",
  ggtp: "ggt",
  fastinginsulin: "fastinginsulin",
  insulinfasting: "fastinginsulin",
  nuchterninsulin: "fastinginsulin",
};

/**
 * Labs-catalog slug → canonical LOINC key.
 *
 * Both sides are app-owned stable identities with no language in them, which
 * is the whole point: this is the only edit a new locale does NOT need. A
 * biomarker minted from the catalog stores whatever `labs.catalog.<slug>` said
 * in the language of the person who minted it, and that name is what reaches
 * the FHIR exporter as free text. Pinning the slug once means every
 * translation of it resolves.
 *
 * Slugs absent here are catalog markers with no entry in `LAB_LOINC_BY_KEY`
 * (T3, T4, B12, folate, the electrolytes, most of the blood count) — that map
 * is conservative by design and text-only stays the honest default for them.
 * Adding one is a decision about a LOINC term, not about a language.
 */
export const CATALOG_SLUG_TO_LOINC_KEY: Record<string, string> = {
  "total-cholesterol": "cholesterol",
  ldl: "ldlc",
  hdl: "hdlc",
  triglycerides: "triglycerides",
  "fasting-glucose": "glucosefasting",
  hba1c: "hba1c",
  tsh: "tsh",
  ferritin: "ferritin",
  "vitamin-d": "vitamind",
  "hs-crp": "hscrp",
  creatinine: "creatinine",
  egfr: "egfr",
  alt: "alt",
  ast: "ast",
  ggt: "ggt",
  hemoglobin: "hemoglobin",
  apob: "apob",
  "lp-a": "lpa",
  "fasting-insulin": "fastinginsulin",
};

/**
 * Localised analyte name → canonical LOINC key, DERIVED from
 * `messages/<locale>.json` rather than transcribed out of it.
 *
 * That is the load-bearing part. Before this index, the alias table above was
 * the whole of the mapping and it was written in English and German, so a
 * French account's "Cholestérol total", a Spanish "Colesterol total", an
 * Italian "Colesterolo totale" and a Polish "Cholesterol całkowity" all
 * exported as a text-only concept with no LOINC code, on a document a
 * clinician or another system reads. Transcribing four more languages here
 * would have fixed today's six locales and reopened the same hole on the day a
 * seventh landed. Reading the bundles means a new locale needs no edit in this
 * file: `locales` grows, `messages/xx.json` lands, and the names it ships
 * resolve the same day.
 *
 * The hand-written aliases WIN on a conflict. They were verified one by one
 * over several releases; a derived name that folds onto the same key as one of
 * them is a duplicate and harmless, and one that folds onto a DIFFERENT key
 * would be a bundle bug, so it is refused here and the guard suite fails on
 * it — a translation typo must not quietly re-point an existing alias at
 * another analyte.
 *
 * Known limit: the index is built from the names the bundles carry TODAY,
 * while the analytes it resolves were typed in the past. Editing a shipped
 * `labs.catalog.<slug>` string orphans the biomarkers minted under the old
 * wording; the fix for that is a legacy row in `LAB_ALIASES`, not a migration.
 */
function buildLocalisedAliases(): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [slug, loincKey] of Object.entries(CATALOG_SLUG_TO_LOINC_KEY)) {
    for (const name of localisedValues(`labs.catalog.${slug}`)) {
      const key = normaliseLabKey(name);
      if (!key) continue;
      if (LAB_LOINC_BY_KEY[key] || LAB_ALIASES[key]) continue;
      if (index[key] && index[key] !== loincKey) continue;
      index[key] = loincKey;
    }
  }
  return index;
}

let memoLocalisedLabAliasesCache:
  ReturnType<typeof memoLocalisedLabAliasesBuild> | undefined;
/** Built on first use, not at module load: it reads every shipped catalog. */
function memoLocalisedLabAliases(): ReturnType<
  typeof memoLocalisedLabAliasesBuild
> {
  return (memoLocalisedLabAliasesCache ??= memoLocalisedLabAliasesBuild());
}
function memoLocalisedLabAliasesBuild() {
  return buildLocalisedAliases();
}

/**
 * Test seam: the guard suite asserts the derived index covers every shipped
 * locale and contradicts no hand-written alias. Production reads the constant.
 */
export function localisedLabAliases(): Readonly<Record<string, string>> {
  return memoLocalisedLabAliases();
}

/**
 * Canonical UCUM symbols that a recorded free-text unit may normalise to. The
 * LEFT is the normalised (lower-cased, punctuation-stripped) recorded unit;
 * the RIGHT is the canonical UCUM symbol. Used to decide whether the lab's
 * unit MATCHES the mapped biomarker's canonical UCUM so the UCUM `code` can be
 * stamped. A non-matching unit keeps the value's `unit` display only (no UCUM
 * `code`) — never a coerced value.
 */
const UNIT_NORMALISATION: Record<string, string> = {
  // percent
  "%": "%",
  pct: "%",
  percent: "%",
  // mg/dL family
  mgdl: "mg/dL",
  "mg/dl": "mg/dL",
  // mg/L
  mgl: "mg/L",
  "mg/l": "mg/L",
  // ng/mL
  ngml: "ng/mL",
  "ng/ml": "ng/mL",
  // ug/L (ferritin)
  ugl: "ug/L",
  "ug/l": "ug/L",
  "µg/l": "ug/L",
  "mcg/l": "ug/L",
  ngml2: "ng/mL",
  "ng/ml2": "ng/mL",
  // g/dL (hemoglobin)
  gdl: "g/dL",
  "g/dl": "g/dL",
  // U/L (enzymes)
  ul: "U/L",
  "u/l": "U/L",
  iul: "U/L",
  "iu/l": "U/L",
  // mIU/L (TSH)
  miul: "m[IU]/L",
  "miu/l": "m[IU]/L",
  uiuml: "m[IU]/L",
  "µiu/ml": "m[IU]/L",
  "uiu/ml": "m[IU]/L",
  // eGFR rate
  mlmin173m2: "mL/min/{1.73_m2}",
  "ml/min/1.73m2": "mL/min/{1.73_m2}",
  "ml/min/1.73sqm": "mL/min/{1.73_m2}",
};

/** Normalise a recorded unit string for canonical-UCUM matching. */
function normaliseUnit(unit: string): string {
  const trimmed = unit.trim();
  // Try the verbatim-lowercase form first (covers "mg/dL" → "mg/dl"), then the
  // punctuation-stripped form (covers "mg dl" / "mgdl"). Both routes resolve
  // through the same table so equivalent spellings collapse.
  const lower = trimmed.toLowerCase();
  if (UNIT_NORMALISATION[lower]) return UNIT_NORMALISATION[lower];
  const stripped = normaliseLabKey(trimmed);
  return UNIT_NORMALISATION[stripped] ?? trimmed;
}

/** The resolved coding for one lab result, or null when the analyte is unmapped. */
export interface ResolvedLabCoding {
  loinc: string;
  display: string;
  /**
   * Canonical UCUM symbol to stamp on the value, ONLY when the recorded unit
   * matches the mapped biomarker's canonical UCUM. Null when the unit does not
   * match (display-only `unit` is kept, no coerced UCUM `code`).
   */
  ucum: string | null;
}

/**
 * Resolve a lab result's LOINC coding + canonical UCUM.
 *
 * Precedence: the v1.19.0 catalog's resolved `canonicalName` (when the DTO
 * carries it — it does not today) wins over the raw free-text `analyte`. The
 * `unit` is matched against the mapped biomarker's canonical UCUM; only an
 * exact (post-normalisation) match yields a UCUM `code`.
 *
 * Returns null when the analyte does not resolve — the caller then keeps the
 * honest text-only + display-unit behaviour (no fabricated codes).
 */
export function resolveLabCoding(
  analyte: string,
  unit: string,
  canonicalName?: string | null,
): ResolvedLabCoding | null {
  const source =
    canonicalName && canonicalName.length > 0 ? canonicalName : analyte;
  const key = normaliseLabKey(source);
  // Canonical key first, then the hand-verified aliases, then the names the
  // shipped bundles carry. The order is the confidence order, and it keeps
  // every resolution that worked before working the same way.
  const resolvedKey = LAB_LOINC_BY_KEY[key]
    ? key
    : (LAB_ALIASES[key] ?? memoLocalisedLabAliases()[key]);
  if (!resolvedKey) return null;
  const mapping = LAB_LOINC_BY_KEY[resolvedKey];
  if (!mapping) return null;
  const ucum = normaliseUnit(unit) === mapping.ucum ? mapping.ucum : null;
  return { loinc: mapping.loinc, display: mapping.display, ucum };
}
