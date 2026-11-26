/**
 * The `recommendation.referenceId` values the AI response schema accepts,
 * one per entry of `MEDICAL_REFERENCES` (`./medical-references.ts`), which
 * types its ids against this list. Kept apart from the bundle because the
 * schema also runs in the browser, where it needs the ids and not the
 * titles and URLs.
 */
export const MEDICAL_REFERENCE_IDS = [
  "esh-2023-bp-adults",
  "esc-2024-bp-cv",
  "aha-2017-hypertension",
  "who-2021-hypertension",
  "who-2024-bmi-classification",
  "dge-2024-healthy-eating",
  "aha-2023-resting-heart-rate",
] as const;

export type MedicalReferenceId = (typeof MEDICAL_REFERENCE_IDS)[number];
