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
