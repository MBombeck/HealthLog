/**
 * v1.41 — does a sentence talk about the person's health?
 *
 * The Coach saves preferences, goals and life context on its own, and only
 * proposes anything that touches a condition, a medication or a limitation.
 * The model's category alone cannot be trusted with that line: "context:
 * started Mounjaro in May" is a medication whatever it was filed under. So
 * the server reads the text too, against closed vocabularies:
 *
 * - medications: the drug-class needles the medication pages already resolve
 *   by (`resolveMedicationTargets`, INN stems in every shipped spelling), the
 *   GLP-1 brand catalog, and a short list of generic medication words;
 * - conditions: a short closed list of diagnosis and symptom words in the
 *   shipped languages, plus the self-statement patterns of the deterministic
 *   fact matcher (allergies, intolerances, stated diagnoses).
 *
 * Over-matching is the safe direction: a false hit turns an automatic save
 * into a one-tap proposal, never the reverse.
 *
 * Pure; server and tests alike.
 */
import { findDrugIdByBrand } from "@/lib/medications/glp1-knowledge";
import { resolveMedicationTargets } from "@/lib/medications/med-target-map";

/** Words that name medication use in general, in the shipped languages. */
const MEDICATION_WORDS: readonly string[] = [
  // en
  "medication",
  "medications",
  "medicine",
  "meds",
  "pill",
  "pills",
  "tablet",
  "tablets",
  "dose",
  "dosage",
  "injection",
  "injections",
  "prescription",
  "prescribed",
  "statin",
  "statins",
  "insulin",
  "antidepressant",
  "antidepressants",
  "contraceptive",
  "inhaler",
  // de
  "medikament",
  "medikamente",
  "medikation",
  "tablette",
  "tabletten",
  "pille",
  "dosis",
  "spritze",
  "spritzen",
  "rezept",
  "verschrieben",
  "blutdrucksenker",
  "antidepressivum",
  "antidepressiva",
  // fr / es / it / pl
  "médicament",
  "médicaments",
  "medicamento",
  "medicamentos",
  "farmaco",
  "farmaci",
  "lek",
  "leki",
];

/** Diagnosis, symptom and limitation words, in the shipped languages. */
const CONDITION_WORDS: readonly string[] = [
  // en
  "diabetes",
  "diabetic",
  "hypertension",
  "asthma",
  "allergy",
  "allergic",
  "intolerance",
  "intolerant",
  "depression",
  "anxiety",
  "migraine",
  "migraines",
  "arthritis",
  "cancer",
  "thyroid",
  "hypothyroidism",
  "hyperthyroidism",
  "apnea",
  "apnoea",
  "insomnia",
  "adhd",
  "pcos",
  "endometriosis",
  "epilepsy",
  "copd",
  "disease",
  "disorder",
  "syndrome",
  "diagnosed",
  "diagnosis",
  "condition",
  "injury",
  "injured",
  "surgery",
  "pregnant",
  "pregnancy",
  "chronic",
  "pain",
  "afib",
  "arrhythmia",
  // de
  "bluthochdruck",
  "hypertonie",
  "asthma",
  "allergie",
  "allergisch",
  "unverträglichkeit",
  "intoleranz",
  "depression",
  "depressionen",
  "angststörung",
  "migräne",
  "arthrose",
  "krebs",
  "schilddrüse",
  "schlafapnoe",
  "schlaflosigkeit",
  "krankheit",
  "erkrankung",
  "erkrankt",
  "diagnose",
  "diagnostiziert",
  "verletzung",
  "verletzt",
  "operation",
  "schwanger",
  "schwangerschaft",
  "chronisch",
  "schmerzen",
  "vorhofflimmern",
  "herzrhythmusstörung",
  "bandscheibenvorfall",
  // fr / es / it / pl
  "diabète",
  "maladie",
  "enfermedad",
  "malattia",
  "choroba",
  "cukrzyca",
];

/** The categories a lexicon hit forces. */
export type HealthTermKind = "medication" | "condition";

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((word) => word.length > 1);
}

const MEDICATION_SET = new Set(MEDICATION_WORDS);
const CONDITION_SET = new Set(CONDITION_WORDS);

/**
 * German compounds carry the condition at the end ("Erdnussallergie",
 * "Laktoseintoleranz", "Rückenschmerzen"): a word that ends in one of these
 * counts as a condition word too.
 */
const CONDITION_SUFFIXES: readonly string[] = [
  "allergie",
  "unverträglichkeit",
  "intoleranz",
  "erkrankung",
  "krankheit",
  "schmerzen",
  "diabetes",
];

/**
 * Whether the text names a medication or a health condition, and which.
 * Medication wins when both are present: it is the narrower category, and
 * the module gate (`medications`) applies to it.
 */
export function healthTermKind(text: string): HealthTermKind | null {
  const tokens = words(text);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    if (MEDICATION_SET.has(token)) return "medication";
    if (token.length >= 4 && findDrugIdByBrand(token) !== null) {
      return "medication";
    }
  }
  if (resolveMedicationTargets({ name: text }) !== null) return "medication";
  for (const token of tokens) {
    if (CONDITION_SET.has(token)) return "condition";
    if (
      CONDITION_SUFFIXES.some(
        (suffix) => token.length > suffix.length && token.endsWith(suffix),
      )
    ) {
      return "condition";
    }
  }
  return null;
}

/** Whether the text names a medication or a health condition. */
export function containsHealthTerm(text: string): boolean {
  return healthTermKind(text) !== null;
}
