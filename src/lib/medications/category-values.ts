/**
 * Clinical-category values stored in the `medication_categories` table
 * (TEXT column, the `MedicationCategoryAssignment` model). The column is a
 * plain TEXT field — no Prisma enum exists to migrate; `base.ts` builds the
 * Zod schema from this tuple as the only enforcement layer, while this module
 * provides a dependency-free source for client bundles.
 *
 * The v1.5.4 release added `DIABETES` and `ANTIBIOTIC` so the wizard's Step 2 taxonomy can
 * write a first-class bucket for those two rows instead of collapsing them into
 * `OTHER`. v1.39.4 adds `MENTAL_HEALTH` (antidepressants, anxiolytics, mood
 * stabilisers, ADHD medication), again without a migration.
 */

export const MEDICATION_CATEGORY_VALUES = [
  "BLOOD_PRESSURE",
  "VITAMIN",
  "SUPPLEMENT",
  "PAIN_RELIEF",
  "ALLERGY",
  "DIGESTIVE",
  "THYROID",
  "HORMONE",
  "SKIN",
  "SLEEP_AID",
  "DIABETES",
  "ANTIBIOTIC",
  "MENTAL_HEALTH",
  "OTHER",
] as const;

export type MedicationCategoryValue =
  (typeof MEDICATION_CATEGORY_VALUES)[number];

/**
 * A custom category's key, `custom:<uuid>` (the key of its
 * `MedicationCategoryLabel` row). The one definition the write schemas and
 * the list layout check against.
 */
export const CUSTOM_MEDICATION_CATEGORY_KEY_PATTERN = /^custom:[0-9a-f-]{36}$/;

/** Is `value` a well-formed category key: a built-in value or a custom key? */
export function isMedicationCategoryKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ((MEDICATION_CATEGORY_VALUES as readonly string[]).includes(value) ||
      CUSTOM_MEDICATION_CATEGORY_KEY_PATTERN.test(value))
  );
}
