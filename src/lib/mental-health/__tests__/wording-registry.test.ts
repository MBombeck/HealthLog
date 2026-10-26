import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";

import { INSTRUMENTS, INSTRUMENT_ORDER } from "../instruments";
import { hasFunctionalItem } from "../instrument-wording";
import { WORDING } from "../wording";
import { SINGLE_ANCHOR_GROUP } from "../wording/types";

/**
 * Every questionnaire has wording in every app language, and every entry says
 * what it is: a validated translation with its source, or a translation
 * written for HealthLog. The shape is checked against the scoring contract in
 * `instruments.ts`, so an entry cannot carry an item too few or an answer
 * bound to the wrong score.
 */

const CELLS = INSTRUMENT_ORDER.flatMap((id) =>
  locales.map((locale) => ({ id, locale, wording: WORDING[id][locale] })),
);

const sorted = (values: Iterable<number | string>) =>
  [...values].map(String).sort();

describe("questionnaire wording registry", () => {
  it("covers every instrument in every app language, and nothing else", () => {
    expect(CELLS).toHaveLength(INSTRUMENT_ORDER.length * locales.length);
    for (const id of INSTRUMENT_ORDER) {
      expect(sorted(Object.keys(WORDING[id]))).toEqual(sorted(locales));
    }
    expect(sorted(Object.keys(WORDING))).toEqual(sorted(INSTRUMENT_ORDER));
  });

  it("holds the English original of every instrument as validated", () => {
    for (const id of INSTRUMENT_ORDER) {
      expect(WORDING[id].en.validated, id).toBe(true);
    }
  });

  it.each(CELLS)(
    "$id / $locale declares validated with a source, or not validated",
    ({ wording }) => {
      if (wording.validated) {
        // A citation that names where the text was read: a link or a DOI,
        // and a year.
        expect(wording.source).toMatch(/https?:\/\/|doi:/);
        expect(wording.source).toMatch(/\b(19|20)\d{2}\b|phqscreeners/);
      } else {
        expect(wording).not.toHaveProperty("source");
      }
    },
  );

  it.each(CELLS)(
    "$id / $locale carries every item, stem and answer the scoring expects",
    ({ id, wording }) => {
      const def = INSTRUMENTS[id];
      const clean = (text: string) => {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(0);
      };

      expect(wording.items).toHaveLength(def.itemCount);
      wording.items.forEach(clean);

      // A stem for every stem the form prints, and none it does not.
      expect(sorted(Object.keys(wording.stems))).toEqual(
        sorted(new Set(def.stemIds)),
      );
      Object.values(wording.stems).forEach(clean);

      // One anchor set per group, each keyed by exactly the scores the item
      // can take, with distinct labels.
      const groups = new Set(def.optionGroups ?? [SINGLE_ANCHOR_GROUP]);
      expect(sorted(Object.keys(wording.anchors))).toEqual(sorted(groups));
      for (const group of groups) {
        const set = wording.anchors[group];
        expect(sorted(Object.keys(set)), group).toEqual(
          sorted(def.optionOrder),
        );
        const labels = def.optionOrder.map((value) => set[value]);
        labels.forEach(clean);
        expect(new Set(labels).size, group).toBe(labels.length);
      }

      if (hasFunctionalItem(id)) {
        expect(wording.functional).toBeDefined();
        clean(wording.functional?.title ?? "");
        expect(sorted(Object.keys(wording.functional?.anchors ?? {}))).toEqual([
          "0",
          "1",
          "2",
          "3",
        ]);
      } else {
        expect(wording.functional).toBeUndefined();
      }
    },
  );

  it("keeps PHQ-9 item 9 the ninth item in every language", () => {
    // The crisis signpost keys on the item's position; a language that
    // reordered or dropped an item would move it.
    expect(INSTRUMENTS.PHQ9.safetyItemIndex).toBe(8);
    for (const locale of locales) {
      expect(WORDING.PHQ9[locale].items).toHaveLength(9);
    }
    expect(WORDING.PHQ9.en.items[8]).toBe(
      "Thoughts that you would be better off dead, or of hurting yourself in some way",
    );
  });

  it("binds every translation's answers to the English scores", () => {
    // The worst score sits at the same end in every language: the anchors
    // for score 0 of the PHQ-9 and of the WHO-5 are the "not at all" /
    // "at no time" ends, which the published spot checks pin per language.
    expect(WORDING.PHQ9.en.anchors.all[0]).toBe("Not at all");
    expect(WORDING.WHO5.en.anchors.all[5]).toBe("All of the time");
    expect(WORDING.SCI.en.anchors.duration[4]).toBe("0–15 min");
    expect(WORDING.SCI.en.anchors.impact[4]).toBe("Not at all");
  });
});
