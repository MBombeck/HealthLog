/**
 * v1.4.37 W4b — shared medication category-label lookup.
 *
 * Both the generic `<MedicationCard>` and the GLP-1 variant render
 * `categoryLabel` into the same `<MedicationCardHeader>` outline badge.
 * Historically the generic card kept its own inline lookup table while
 * the GLP-1 card hard-coded `medications.treatmentClassGlp1` into the
 * slot — the maintainer reported the asymmetry during the v1.4.37 UX audit
 * (audit item 11). The GLP-1 nature is already implied by the
 * rotation hint + injection metadata rows, so both surfaces should
 * paint the actual medication category instead.
 *
 * The lookup is a small string map; we keep it as a function that takes
 * the bound `t()` translator so the keys stay one source of truth and
 * we don't need to drill a separate `categoryLabels` object through
 * the card props.
 */

type Translator = (
  key: string,
  params?: Record<string, string | number>,
) => string;

const MEDICATION_CATEGORY_KEYS: Record<string, string> = {
  BLOOD_PRESSURE: "medications.categoryBloodPressure",
  VITAMIN: "medications.categoryVitamin",
  SUPPLEMENT: "medications.categorySupplement",
  PAIN_RELIEF: "medications.categoryPainRelief",
  ALLERGY: "medications.categoryAllergy",
  DIGESTIVE: "medications.categoryDigestive",
  THYROID: "medications.categoryThyroid",
  HORMONE: "medications.categoryHormone",
  SKIN: "medications.categorySkin",
  SLEEP_AID: "medications.categorySleepAid",
  DIABETES: "medications.categoryDiabetes",
  ANTIBIOTIC: "medications.categoryAntibiotic",
  MENTAL_HEALTH: "medications.categoryMentalHealth",
  OTHER: "medications.categoryOther",
};

/**
 * v1.40 (#1041) — a category the person named themselves arrives as
 * `custom:<uuid>` with its decrypted label beside it (`categoryLabel` on the
 * medication wire); that label wins. A custom key without a label (the server
 * resolved it to nothing) reads as Other, like any unknown value.
 */
export function getMedicationCategoryLabel(
  category: string,
  t: Translator,
  customLabel?: string | null,
): string {
  if (customLabel) return customLabel;
  const key = MEDICATION_CATEGORY_KEYS[category] ?? "medications.categoryOther";
  return t(key);
}

/** The built-in category values, in the order the filter row lists them. */
export const BUILT_IN_MEDICATION_CATEGORIES = Object.keys(
  MEDICATION_CATEGORY_KEYS,
);
