/**
 * v1.4.38 — drift-guard between the validation enum and the label-key
 * map. The category enum lives in three places (Prisma schema,
 * `MEDICATION_CATEGORY_VALUES` in the validation module, and the
 * `MEDICATION_CATEGORY_KEYS` lookup inside `category-label.ts`). If a
 * new category lands in the enum without a matching label key, the
 * generic `<MedicationCard>` quietly falls back to `categoryOther`
 * for the new bucket — a silent UX regression. Pin the invariant
 * here so the test suite trips before the regression ships.
 *
 * Symmetric drift (label key present without an enum entry) is also
 * undesirable — it's dead code, but more importantly it suggests the
 * enum dropped a value without removing the lookup, which leaves the
 * label map advertising a category the rest of the app no longer
 * understands.
 */
import { describe, expect, it } from "vitest";

import { MEDICATION_CATEGORY_VALUES } from "@/lib/validations/medication";
import { getMedicationCategoryLabel } from "../category-label";

describe("medication category-label drift-guard", () => {
  it("every MEDICATION_CATEGORY_VALUES entry resolves to a distinct label key", () => {
    // Use a no-op translator that echoes the key back so we can
    // distinguish "real key" from the OTHER fallback.
    const echo = (key: string) => key;
    const fallback = "medications.categoryOther";

    for (const value of MEDICATION_CATEGORY_VALUES) {
      const resolved = getMedicationCategoryLabel(value, echo);
      if (value === "OTHER") {
        expect(resolved).toBe(fallback);
        continue;
      }
      // Any non-OTHER enum value that resolves to the OTHER key is a
      // drift bug — the value made it into the enum without a
      // matching label entry, so the card silently labels the
      // category as "Sonstige".
      expect(
        resolved,
        `enum value "${value}" falls back to categoryOther — add a key in MEDICATION_CATEGORY_KEYS to cover it`,
      ).not.toBe(fallback);
    }
  });

  it("the fallback path still fires for an unknown category value", () => {
    const echo = (key: string) => key;
    expect(getMedicationCategoryLabel("NOT_A_REAL_CATEGORY", echo)).toBe(
      "medications.categoryOther",
    );
  });
});
