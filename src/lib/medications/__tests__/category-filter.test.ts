import { describe, expect, it } from "vitest";

import {
  ALL_MEDICATION_CATEGORIES,
  effectiveCategoryFilter,
  filterMedicationsByCategory,
  medicationCategoryOptions,
} from "@/lib/medications/category-filter";
import { getMedicationCategoryLabel } from "@/lib/medications/category-label";

const KEY = "custom:11111111-1111-4111-8111-111111111111";
const t = (key: string) => `t:${key}`;

const MEDS = [
  { id: "a", active: true, category: "THYROID", categoryLabel: null },
  { id: "b", active: true, category: KEY, categoryLabel: "Travel kit" },
  { id: "c", active: false, category: KEY, categoryLabel: "Travel kit" },
  { id: "d", active: false, category: "THYROID", categoryLabel: null },
];

describe("medication category filter (v1.40, #1041)", () => {
  it("offers each category in use once, labelled like the card badge", () => {
    expect(medicationCategoryOptions(MEDS, t)).toEqual([
      { value: "THYROID", label: "t:medications.categoryThyroid" },
      { value: KEY, label: "Travel kit" },
    ]);
  });

  it("narrows the active and the inactive block alike", () => {
    const active = MEDS.filter((m) => m.active);
    const inactive = MEDS.filter((m) => !m.active);
    expect(filterMedicationsByCategory(active, KEY).map((m) => m.id)).toEqual([
      "b",
    ]);
    expect(filterMedicationsByCategory(inactive, KEY).map((m) => m.id)).toEqual(
      ["c"],
    );
    expect(
      filterMedicationsByCategory(active, ALL_MEDICATION_CATEGORIES).map(
        (m) => m.id,
      ),
    ).toEqual(["a", "b"]);
  });

  it("falls back to All when the stored pick is no longer in use", () => {
    const options = medicationCategoryOptions(MEDS, t);
    expect(effectiveCategoryFilter(KEY, options)).toBe(KEY);
    expect(
      effectiveCategoryFilter(
        "custom:99999999-9999-4999-8999-999999999999",
        options,
      ),
    ).toBe(ALL_MEDICATION_CATEGORIES);
  });

  it("labels a custom category by its own label and an unresolved key as Other", () => {
    expect(getMedicationCategoryLabel(KEY, t, "Travel kit")).toBe("Travel kit");
    expect(getMedicationCategoryLabel(KEY, t, null)).toBe(
      "t:medications.categoryOther",
    );
    expect(getMedicationCategoryLabel("VITAMIN", t)).toBe(
      "t:medications.categoryVitamin",
    );
  });
});
