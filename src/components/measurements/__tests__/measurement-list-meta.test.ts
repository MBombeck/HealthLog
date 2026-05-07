import { describe, it, expect } from "vitest";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  MEASUREMENT_TYPE_LABEL_KEYS,
  MEASUREMENT_TYPE_ICONS,
  MEASUREMENT_TYPE_COLORS,
} from "../measurement-list-meta";
import enMessages from "../../../../messages/en.json";
import deMessages from "../../../../messages/de.json";

/**
 * Issue #109 root cause: measurement-list maps drifted from the canonical
 * measurementTypeEnum. New enum values silently fell through to the raw
 * string fallback. These tests fail fast if a new enum value is added
 * without a corresponding entry in every list-UI map.
 */
describe("measurement-list-meta", () => {
  const allTypes = [...measurementTypeEnum.options].sort();

  it("MEASUREMENT_TYPE_LABEL_KEYS covers every measurement type", () => {
    expect(Object.keys(MEASUREMENT_TYPE_LABEL_KEYS).sort()).toEqual(allTypes);
  });

  it("MEASUREMENT_TYPE_ICONS covers every measurement type", () => {
    expect(Object.keys(MEASUREMENT_TYPE_ICONS).sort()).toEqual(allTypes);
  });

  it("MEASUREMENT_TYPE_COLORS covers every measurement type", () => {
    expect(Object.keys(MEASUREMENT_TYPE_COLORS).sort()).toEqual(allTypes);
  });

  it("every label key resolves in both English and German locales", () => {
    type Bag = { measurements?: Record<string, string> };
    const en = (enMessages as Bag).measurements ?? {};
    const de = (deMessages as Bag).measurements ?? {};

    for (const [type, key] of Object.entries(MEASUREMENT_TYPE_LABEL_KEYS)) {
      const leaf = key.replace(/^measurements\./, "");
      expect(en[leaf], `EN missing ${key} for ${type}`).toBeTruthy();
      expect(de[leaf], `DE missing ${key} for ${type}`).toBeTruthy();
    }
  });
});
