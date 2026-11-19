/**
 * The manual-entry form offers every body-composition reading the server
 * accepts from a person (#1013).
 *
 * The form keeps a hand-written type list, and the server's list of
 * measurement types grew past it: visceral fat, fat mass, fat-free mass and
 * lean body mass all arrived from scales and Apple Health, with units and
 * plausibility ranges, while a person reading the same number off a scale's
 * display had no row to type it into. Nothing noticed, because nothing
 * compared the two.
 *
 * The comparison is derived from the server's own grouping
 * (`MEASUREMENT_CATEGORIES`, the "body" family), so a type added to that
 * family later fails here until it is either given a form row or named below
 * with the reason a person would not type it.
 */
import { describe, it, expect } from "vitest";

import { MEASUREMENT_CATEGORIES } from "@/lib/measurements/categories";
import { VALUE_RANGES, getUnitForType } from "@/lib/validations/measurement";
import { hasDisplayTransform } from "@/lib/measurements/display-transform";
import { parseDecimalEntry } from "@/lib/measurements/entry-units";
import {
  MEASUREMENT_FORM_TYPE_VALUES,
  MEASUREMENT_TYPES,
} from "@/components/measurements/measurement-form";
import en from "../../../../messages/en.json";

/**
 * Body-composition types deliberately absent from the manual form, each with
 * the reason. Keep this list short and honest: "a scale reports it" is a
 * reason to be in the form, not out of it.
 */
const NOT_HAND_ENTERED: Readonly<Record<string, string>> = {
  BODY_MASS_INDEX:
    "Derived from weight and height. A typed copy would be a second number that can disagree with the weight it came from.",
  MENOPAUSAL_STATE:
    "A HealthKit category state stored as its codepoint (1 menopause, 2 perimenopause, 3 none). A number field would ask the person to type a code, not a reading.",
  BLEEDING_AFTER_MENOPAUSE:
    "A HealthKit category stored as its bleeding codepoint (1 unspecified to 5 none). A number field would ask the person to type a code, not a reading.",
};

const BODY_COMPOSITION = [...MEASUREMENT_CATEGORIES.entries()]
  .filter(([, category]) => category === "body")
  .map(([type]) => type as string);

function translate(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
}

describe("manual measurement form — body composition", () => {
  it("reads a non-empty body family off the server's categories", () => {
    // A guard over an empty set passes for the wrong reason.
    expect(BODY_COMPOSITION.length).toBeGreaterThan(5);
    expect(BODY_COMPOSITION).toContain("VISCERAL_FAT");
  });

  it.each(BODY_COMPOSITION)(
    "%s is offered in the form or excluded with a reason",
    (type) => {
      const inForm = MEASUREMENT_FORM_TYPE_VALUES.includes(type);
      const excluded = type in NOT_HAND_ENTERED;
      expect(
        inForm !== excluded,
        `${type}: add a form row, or name it in NOT_HAND_ENTERED with a reason (and never both)`,
      ).toBe(true);
    },
  );

  it("excludes only real body-composition types, each for a stated reason", () => {
    for (const [type, reason] of Object.entries(NOT_HAND_ENTERED)) {
      expect(BODY_COMPOSITION, `${type} is not a body type`).toContain(type);
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  const formBodyRows = MEASUREMENT_TYPES.filter((row) =>
    BODY_COMPOSITION.includes(row.value),
  );

  it.each(formBodyRows.map((row) => [row.value, row] as const))(
    "%s asks in the unit the server stores, with a label in every place it needs one",
    (type, row) => {
      const canonical = getUnitForType(type);
      expect(canonical).not.toBe("unknown");
      if ("unit" in row && !hasDisplayTransform(type)) {
        expect(row.unit).toBe(canonical);
      }
      if ("unitKey" in row) {
        expect(typeof translate(row.unitKey)).toBe("string");
      }
      expect(typeof translate(row.labelKey)).toBe("string");
    },
  );

  it.each(formBodyRows.map((row) => [row.value, row] as const))(
    "%s suggests a placeholder the server would accept",
    (type, row) => {
      const range = VALUE_RANGES[type];
      expect(range, `${type} has no plausibility range`).toBeDefined();
      const placeholder =
        "placeholder" in row ? parseDecimalEntry(row.placeholder) : null;
      expect(placeholder).not.toBeNull();
      expect(placeholder!).toBeGreaterThanOrEqual(range.min);
      expect(placeholder!).toBeLessThanOrEqual(range.max);
    },
  );
});
