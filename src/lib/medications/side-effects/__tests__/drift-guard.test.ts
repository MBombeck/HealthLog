/**
 * v1.4.25 W21 Fix-N (code-M1 + simp-M1) — drift guard.
 *
 * Three sources of truth historically described the side-effect enum:
 *
 *   1. The Prisma `MedicationSideEffectCategory` + `MedicationSideEffectEntry`
 *      enums (DB-level CHECK constraints).
 *   2. The taxonomy module (`SIDE_EFFECT_CATEGORIES` map + the
 *      `SIDE_EFFECT_ENTRIES_BY_CATEGORY` grouping).
 *   3. The Zod validators (`SIDE_EFFECT_CATEGORY_VALUES` /
 *      `SIDE_EFFECT_ENTRY_VALUES`).
 *
 * Adding a new entry historically required touching all three; any
 * single omission silently broke production (e.g. a Prisma migration
 * adds a new value, but the Zod validator's tuple still rejects it on
 * the wire → 422 surface that maps to a value the DB will gladly
 * accept). Now the validators DERIVE from the Prisma enum, and this
 * test asserts the three keysets stay in lockstep.
 *
 * If any of these assertions fail: a new entry was added in Prisma
 * but the taxonomy map / category grouping wasn't updated — fix those
 * before merging.
 */

import { describe, expect, it } from "vitest";

import {
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
} from "@/generated/prisma/client";
import {
  SIDE_EFFECT_CATEGORY_VALUES,
  SIDE_EFFECT_ENTRY_VALUES,
} from "../validators";
import {
  SIDE_EFFECT_CATEGORIES,
  SIDE_EFFECT_CATEGORY_ORDER,
  SIDE_EFFECT_ENTRIES_BY_CATEGORY,
  SIDE_EFFECT_ENTRY_COUNT,
} from "../taxonomy";

function sortedKeys<T extends string>(keys: readonly T[]): T[] {
  return [...keys].sort();
}

describe("side-effect taxonomy drift guard", () => {
  describe("category keysets", () => {
    it("validator categories equal Prisma enum categories", () => {
      const prisma = Object.values(MedicationSideEffectCategory);
      expect(sortedKeys(SIDE_EFFECT_CATEGORY_VALUES)).toEqual(
        sortedKeys(prisma),
      );
    });

    it("taxonomy category order equals Prisma enum categories", () => {
      const prisma = Object.values(MedicationSideEffectCategory);
      expect(sortedKeys(SIDE_EFFECT_CATEGORY_ORDER)).toEqual(
        sortedKeys(prisma),
      );
    });

    it("entries-by-category covers every Prisma category", () => {
      const prisma = Object.values(MedicationSideEffectCategory);
      const grouping = Object.keys(SIDE_EFFECT_ENTRIES_BY_CATEGORY);
      expect(sortedKeys(grouping)).toEqual(sortedKeys(prisma));
    });
  });

  describe("entry keysets", () => {
    it("validator entries equal Prisma enum entries", () => {
      const prisma = Object.values(MedicationSideEffectEntry);
      expect(sortedKeys(SIDE_EFFECT_ENTRY_VALUES)).toEqual(
        sortedKeys(prisma),
      );
    });

    it("taxonomy SIDE_EFFECT_CATEGORIES covers every Prisma entry", () => {
      const prisma = Object.values(MedicationSideEffectEntry);
      const taxonomy = Object.keys(SIDE_EFFECT_CATEGORIES);
      expect(sortedKeys(taxonomy)).toEqual(sortedKeys(prisma));
    });

    it("SIDE_EFFECT_ENTRIES_BY_CATEGORY covers every Prisma entry exactly once", () => {
      const fromGrouping = Object.values(SIDE_EFFECT_ENTRIES_BY_CATEGORY)
        .flat()
        .sort();
      const prisma = sortedKeys(Object.values(MedicationSideEffectEntry));
      expect(fromGrouping).toEqual(prisma);
    });

    it("SIDE_EFFECT_ENTRY_COUNT matches the live Prisma enum size", () => {
      expect(SIDE_EFFECT_ENTRY_COUNT).toBe(
        Object.values(MedicationSideEffectEntry).length,
      );
    });
  });

  describe("category-for-entry agreement", () => {
    it("every entry in SIDE_EFFECT_CATEGORIES maps to a known category", () => {
      for (const category of Object.values(SIDE_EFFECT_CATEGORIES)) {
        expect(Object.values(MedicationSideEffectCategory)).toContain(category);
      }
    });

    it("grouping-side and map-side agree on every (entry, category) pair", () => {
      for (const [category, entries] of Object.entries(
        SIDE_EFFECT_ENTRIES_BY_CATEGORY,
      )) {
        for (const entry of entries) {
          expect(SIDE_EFFECT_CATEGORIES[entry]).toBe(category);
        }
      }
    });
  });
});
