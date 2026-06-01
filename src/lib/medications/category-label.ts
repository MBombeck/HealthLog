/**
 * v1.4.37 W4b — shared medication category-label lookup.
 *
 * Both the generic `<MedicationCard>` and the GLP-1 variant render
 * `categoryLabel` into the same `<MedicationCardHeader>` outline badge.
 * Historically the generic card kept its own inline lookup table while
 * the GLP-1 card hard-coded `medications.treatmentClassGlp1` into the
 * slot — Marc reported the asymmetry during the v1.4.37 UX audit
 * (audit item 11). The GLP-1 nature is already implied by the
 * rotation hint + injection metadata rows, so both surfaces should
 * paint the actual medication category instead.
 *
 * The lookup is a small string map; we keep it as a function that takes
 * the bound `t()` translator so the keys stay one source of truth and
 * we don't need to drill a separate `categoryLabels` object through
 * the card props.
 */

type Translator = (key: string, params?: Record<string, string | number>) => string;

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
  OTHER: "medications.categoryOther",
};

export function getMedicationCategoryLabel(
  category: string,
  t: Translator,
): string {
  const key = MEDICATION_CATEGORY_KEYS[category] ?? "medications.categoryOther";
  return t(key);
}
