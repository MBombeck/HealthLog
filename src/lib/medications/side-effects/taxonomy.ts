/**
 * v1.4.25 W19d — GLP-1 side-effect taxonomy (pure module).
 *
 * Single source of truth for the entry → category mapping the picker
 * UI, the API validator, and the Coach snapshot all read. Derived
 * from EMA EPAR §4.8 ("Undesirable effects") for tirzepatide /
 * semaglutide / liraglutide / dulaglutide, clustered into HealthLog's
 * five surface categories:
 *
 *   - GI                — gastrointestinal (very common during titration)
 *   - METABOLIC         — hypo / dehydration / appetite-suppression edges
 *   - INJECTION_SITE    — local-site reactions (EMA "common")
 *   - COGNITIVE         — brain-fog / dizziness / mood / energy (HealthLog
 *                         keeps these on the medication record because
 *                         the user wants the drug-correlation surface;
 *                         the existing MoodEntry stream is independent).
 *   - GLP1_SPECIFIC     — the four drug-mechanism signatures (early
 *                         satiety, gastroparesis-like fullness, taste
 *                         change, gallbladder discomfort).
 *
 * The DB stores `category` denormalised so range / category-filter
 * queries don't need a JOIN, but this module is the authority — the
 * API write path derives the category from the entry instead of
 * trusting the client.
 *
 * Severity is 1-5 Likert. The semantic-label helper returns a
 * locale-agnostic ladder key (`mild` → `verySevere`); the UI maps each
 * key to a translated label.
 */

import {
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
} from "@/generated/prisma/client";

export const SIDE_EFFECT_CATEGORIES: Record<
  MedicationSideEffectEntry,
  MedicationSideEffectCategory
> = {
  // GI (5)
  NAUSEA: "GI",
  VOMITING: "GI",
  DIARRHEA: "GI",
  CONSTIPATION: "GI",
  ABDOMINAL_PAIN: "GI",
  // Metabolic (4)
  HYPOGLYCEMIA_SYMPTOMS: "METABOLIC",
  DEHYDRATION: "METABOLIC",
  ANOREXIA: "METABOLIC",
  ELECTROLYTE_FATIGUE: "METABOLIC",
  // Injection-site (4)
  INJECTION_REDNESS: "INJECTION_SITE",
  INJECTION_SWELLING: "INJECTION_SITE",
  INJECTION_BRUISING: "INJECTION_SITE",
  INJECTION_INDURATION: "INJECTION_SITE",
  // Cognitive (4)
  BRAIN_FOG: "COGNITIVE",
  DIZZINESS: "COGNITIVE",
  LOW_MOOD: "COGNITIVE",
  LOW_ENERGY: "COGNITIVE",
  // GLP-1 specific (4)
  EARLY_SATIETY: "GLP1_SPECIFIC",
  GASTROPARESIS_LIKE: "GLP1_SPECIFIC",
  DYSGEUSIA: "GLP1_SPECIFIC",
  GALLBLADDER_DISCOMFORT: "GLP1_SPECIFIC",
};

/**
 * Total entry count exposed as a const so callers (validators,
 * snapshot aggregators) can assert against drift without re-counting.
 */
export const SIDE_EFFECT_ENTRY_COUNT = 21;

/**
 * Ordered category list — defines the picker UI's category-tab
 * sequence. Stable across versions; new categories append.
 */
export const SIDE_EFFECT_CATEGORY_ORDER: readonly MedicationSideEffectCategory[] =
  [
    "GI",
    "METABOLIC",
    "INJECTION_SITE",
    "COGNITIVE",
    "GLP1_SPECIFIC",
  ] as const;

/**
 * Entries grouped under each category in picker-UI order. The order
 * within a category mirrors the EMA EPAR §4.8 listing where one
 * exists, then EMA-derived HealthLog clustering for the rest.
 */
export const SIDE_EFFECT_ENTRIES_BY_CATEGORY: Record<
  MedicationSideEffectCategory,
  readonly MedicationSideEffectEntry[]
> = {
  GI: ["NAUSEA", "VOMITING", "DIARRHEA", "CONSTIPATION", "ABDOMINAL_PAIN"],
  METABOLIC: [
    "HYPOGLYCEMIA_SYMPTOMS",
    "DEHYDRATION",
    "ANOREXIA",
    "ELECTROLYTE_FATIGUE",
  ],
  INJECTION_SITE: [
    "INJECTION_REDNESS",
    "INJECTION_SWELLING",
    "INJECTION_BRUISING",
    "INJECTION_INDURATION",
  ],
  COGNITIVE: ["BRAIN_FOG", "DIZZINESS", "LOW_MOOD", "LOW_ENERGY"],
  GLP1_SPECIFIC: [
    "EARLY_SATIETY",
    "GASTROPARESIS_LIKE",
    "DYSGEUSIA",
    "GALLBLADDER_DISCOMFORT",
  ],
} as const;

/**
 * Lookup helper — returns the entries for a category. Used by the
 * picker UI to filter the chip list when the user changes category.
 */
export function entriesByCategory(
  category: MedicationSideEffectCategory,
): readonly MedicationSideEffectEntry[] {
  return SIDE_EFFECT_ENTRIES_BY_CATEGORY[category];
}

/**
 * Lookup helper — returns the category for an entry. The API write
 * path uses this instead of trusting a client-supplied category, so a
 * mismatched payload never lands in the DB.
 */
export function categoryForEntry(
  entry: MedicationSideEffectEntry,
): MedicationSideEffectCategory {
  return SIDE_EFFECT_CATEGORIES[entry];
}

/** 1-5 Likert severity scale. */
export type SideEffectSeverity = 1 | 2 | 3 | 4 | 5;

/** Locale-agnostic semantic labels for the severity ladder. */
export type SideEffectSeverityLabel =
  | "mild"
  | "moderate"
  | "significant"
  | "severe"
  | "verySevere";

/**
 * Maps a 1-5 severity integer to its locale-agnostic semantic label.
 * The UI looks up the translated label via
 * `t("medications.sideEffects.severity.<label>")`.
 *
 * Ordering is fixed: mild < moderate < significant < severe <
 * verySevere. Tests assert determinism + ordering.
 */
export function severityLikertLabel(
  severity: SideEffectSeverity,
): SideEffectSeverityLabel {
  switch (severity) {
    case 1:
      return "mild";
    case 2:
      return "moderate";
    case 3:
      return "significant";
    case 4:
      return "severe";
    case 5:
      return "verySevere";
  }
}

/**
 * Ordered severity-label ladder — useful for the picker UI which
 * renders five Likert buttons in ascending severity order.
 */
export const SIDE_EFFECT_SEVERITY_LADDER: readonly SideEffectSeverityLabel[] = [
  "mild",
  "moderate",
  "significant",
  "severe",
  "verySevere",
] as const;

/**
 * Type guard — narrows a raw number into the SideEffectSeverity union.
 * The Zod schema enforces this on the wire; the guard is for code
 * paths that read the persisted integer back.
 */
export function isSideEffectSeverity(
  value: number,
): value is SideEffectSeverity {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}
