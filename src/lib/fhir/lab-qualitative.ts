/**
 * v1.18.9 — qualitative lab result → SNOMED CT concept (or honest text-only).
 *
 * A qualitative serology result ("negativ" / "positiv" / "nicht nachweisbar")
 * has no number, so its FHIR Observation carries a `valueCodeableConcept`
 * instead of a `valueQuantity`. This module maps common result terms onto a
 * small set of WELL-ESTABLISHED SNOMED CT qualifier-value concepts. The raw
 * recorded text ALWAYS rides `.text`; a coded `coding` is added only when the
 * term resolves CONFIDENTLY. When in doubt the result stays text-only — never
 * a fabricated code — mirroring the conservative stance of the `lab-loinc` and
 * `illness-snomed` mappers.
 *
 * Concepts (SNOMED CT International, qualifier value, REFERENCED not
 * redistributed per the licence):
 *   - 260385009  "Negative"     — every locale's `labs.form.qualNegative`
 *   - 10828004   "Positive"     — every locale's `labs.form.qualPositive`
 *   - 260415000  "Not detected" — nicht nachweisbar / not detected
 *   - 260373001  "Detected"     — nachweisbar / detected
 *
 * The negative and positive arms are DERIVED from `messages/<locale>.json`.
 * The lab form offers those two as quick picks and writes the label it
 * rendered, so what lands in the column is the bundle's own string —
 * "négatif", "negativo", "ujemny" — and matching it against a transcribed
 * English/German list meant four of the six shipped locales recorded a result
 * the export then could not code. Deriving means a new locale is coded the day
 * its bundle lands, with no edit here.
 *
 * The detected / not-detected arm is NOT derived, because the app ships no
 * string for it: those are terms a LAB printed and a person copied in. It
 * stays the hand-written English and German pair it has always been, and the
 * honest cost is that "non détecté" or "niewykrywalny" stay text-only. Coding
 * them would mean inventing clinical vocabulary in four languages nobody here
 * can check, and this module's own rule is that an unverified code is worse
 * than an honest `.text`. When those terms need coding, they need a quick pick
 * in the form and a bundle key — the same route the negative and positive arms
 * took.
 *
 * Borderline / grenzwertig is DELIBERATELY left text-only: the candidate
 * "Borderline" qualifier concept could not be confidently verified. Its bundle
 * key is therefore read by nothing here, on purpose. Any unrecognised term
 * likewise stays text-only.
 *
 * SERVER-ONLY: the derived index reads every shipped message bundle. Its one
 * caller is the FHIR exporter, which runs on the server.
 *
 * Systems: SNOMED CT — http://snomed.info/sct
 */

import type { FhirCodeableConcept } from "@/lib/fhir/types";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { localisedValues } from "@/lib/i18n/shared-resolve";
import { ownRecord, ownValue, type OwnRecord } from "@/lib/own-key";

/**
 * SNOMED CT system URI. Inlined (rather than imported from `resources.ts`) to
 * keep this leaf module free of the heavy `resources.ts` import graph and avoid
 * an import cycle — `resources.ts` consumes THIS module.
 */
const SNOMED_SYSTEM = "http://snomed.info/sct";

interface QualitativeConcept {
  code: string;
  display: string;
}

const NEGATIVE: QualitativeConcept = { code: "260385009", display: "Negative" };
const POSITIVE: QualitativeConcept = { code: "10828004", display: "Positive" };

/**
 * Hand-written result terms → SNOMED qualifier-value concept. The left side is
 * the folded recorded text.
 *
 * What belongs here is what the app ships no string for: the clinical
 * shorthand a person types ("neg", "pos") and the detected / not-detected pair
 * a lab prints. The negative and positive WORDS are not transcribed here — see
 * the derived index below.
 */
const HAND_WRITTEN_SNOMED: Record<string, QualitativeConcept> = {
  neg: NEGATIVE,
  pos: POSITIVE,
  "nicht nachweisbar": { code: "260415000", display: "Not detected" },
  "not detected": { code: "260415000", display: "Not detected" },
  nachweisbar: { code: "260373001", display: "Detected" },
  detected: { code: "260373001", display: "Detected" },
};

/**
 * The quick-pick labels, in every shipped locale, read out of the bundles.
 *
 * The form writes the label it rendered, so this index and the write side
 * cannot drift: whatever `labs.form.qualNegative` says in a language is
 * exactly what a reading recorded in that language holds. `qualBorderline` is
 * deliberately absent — see the module comment.
 */
function buildLocalisedIndex(): OwnRecord<QualitativeConcept> {
  const index = ownRecord<QualitativeConcept>();
  const arms: [string, QualitativeConcept][] = [
    ["labs.form.qualNegative", NEGATIVE],
    ["labs.form.qualPositive", POSITIVE],
  ];
  for (const [key, concept] of arms) {
    for (const label of localisedValues(key)) {
      const folded = foldForMatch(label);
      // A folded label already claimed by the OTHER arm would mean a bundle
      // says the same word means both negative and positive. First wins so a
      // typo cannot take the export down at boot; the guard suite fails on it.
      if (!folded || index[folded]) continue;
      index[folded] = concept;
    }
  }
  return index;
}

let localisedSnomedCache: ReturnType<typeof localisedSnomedBuild> | undefined;
/** Built on first use, not at module load: it reads every shipped catalog. */
function localisedSnomed(): ReturnType<typeof localisedSnomedBuild> {
  return (localisedSnomedCache ??= localisedSnomedBuild());
}
function localisedSnomedBuild() {
  return buildLocalisedIndex();
}

/**
 * Test seam: the guard suite asserts the derived index covers every shipped
 * locale and disagrees with no hand-written term. Production reads the
 * constant.
 */
export function localisedQualitativeIndex(): Readonly<
  Record<string, QualitativeConcept>
> {
  return localisedSnomed();
}

/**
 * Collapse a recorded qualitative term to a lookup key.
 *
 * Folds case, accents and separators, so a reading typed "Negatif" on a
 * keyboard without accents meets the bundle's "négatif", and a stored
 * "negativ" resolves exactly as it did before the fold widened.
 */
function normaliseQualitativeKey(text: string): string {
  return foldForMatch(text);
}

/**
 * Build the `valueCodeableConcept` for a qualitative lab result. The raw text
 * always rides `.text`; a SNOMED `coding` is added only for a confidently-
 * recognised term. Borderline / grenzwertig and any unknown term stay
 * text-only.
 */
export function qualitativeValueConcept(
  valueText: string,
): FhirCodeableConcept {
  const key = normaliseQualitativeKey(valueText);
  const concept =
    ownValue(HAND_WRITTEN_SNOMED, key) ?? ownValue(localisedSnomed(), key);
  if (!concept) {
    return { text: valueText };
  }
  return {
    coding: [
      { system: SNOMED_SYSTEM, code: concept.code, display: concept.display },
    ],
    text: valueText,
  };
}
