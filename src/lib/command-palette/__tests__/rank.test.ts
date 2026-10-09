import { describe, expect, it } from "vitest";

import {
  editDistance,
  normaliseSearchText,
  rankEntries,
  scoreEntry,
} from "@/lib/command-palette/rank";

const e = (title: string, keywords: string[] = []) => ({ title, keywords });

describe("normaliseSearchText", () => {
  it("folds case, diacritics and ß", () => {
    expect(normaliseSearchText("  Größe  Gewícht ")).toBe("grosse gewicht");
    expect(normaliseSearchText("Préférences")).toBe("preferences");
  });
});

describe("editDistance", () => {
  it("counts substitutions, insertions, deletions and adjacent swaps", () => {
    expect(editDistance("sleep", "sleep")).toBe(0);
    expect(editDistance("slep", "sleep")).toBe(1);
    expect(editDistance("selep", "sleep")).toBe(1);
    expect(editDistance("sleap", "sleep")).toBe(1);
    expect(editDistance("abc", "xyz")).toBe(3);
  });

  it("stops early past the allowance", () => {
    expect(editDistance("abcdef", "uvwxyz", 1)).toBe(2);
  });
});

describe("tiers", () => {
  it("prefix beats word start beats contains beats typo beats subsequence", () => {
    const prefix = scoreEntry("blood", e("Blood pressure"));
    const wordStart = scoreEntry("press", e("Blood pressure"));
    const contains = scoreEntry("ressure", e("Blood pressure"));
    const typo = scoreEntry("presure", e("Blood pressure"));
    const subsequence = scoreEntry("bldprs", e("Blood pressure"));
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(contains);
    expect(contains).toBeGreaterThan(typo);
    expect(typo).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it("a multi-word query matches word starts in any order", () => {
    expect(scoreEntry("pres blo", e("Blood pressure"))).toBeGreaterThan(0);
  });

  it("a synonym matches one step below the same match on a title", () => {
    const title = scoreEntry("weight", e("Weight"));
    const synonym = scoreEntry("weight", e("Gewicht", ["weight"]));
    expect(synonym).toBeGreaterThan(0);
    expect(synonym).toBeLessThan(title);
  });

  it("nothing for an empty query or no match", () => {
    expect(scoreEntry("", e("Sleep"))).toBe(0);
    expect(scoreEntry("zzzz", e("Sleep"))).toBe(0);
  });
});

describe("typo tolerance", () => {
  it("one edit from four characters, two from seven", () => {
    expect(scoreEntry("slep", e("Sleep"))).toBeGreaterThan(0);
    expect(scoreEntry("medikamnte", e("Medikamente"))).toBeGreaterThan(0);
    expect(scoreEntry("mdeikamnte", e("Medikamente"))).toBeGreaterThan(0);
  });

  it("no typo allowance under four characters", () => {
    expect(scoreEntry("slp", e("Sleep"))).toBe(100 - 2);
    expect(scoreEntry("xle", e("Sleep"))).toBe(0);
  });

  it("a typo in a partly typed word still finds it", () => {
    expect(scoreEntry("passkye", e("Passkeys"))).toBeGreaterThan(0);
  });
});

describe("rankEntries", () => {
  it("orders by tier, then the shorter title", () => {
    const entries = [
      e("Resting pulse"),
      e("Sleep score"),
      e("Breathing disturbances during sleep"),
      e("Sleep"),
    ];
    expect(rankEntries("sleep", entries).map((x) => x.title)).toEqual([
      "Sleep",
      "Sleep score",
      "Breathing disturbances during sleep",
    ]);
  });

  it("finds a German title from an English word through its synonym", () => {
    const entries = [e("Gewicht", ["weight", "kg"]), e("Gehstrecke")];
    expect(rankEntries("weight", entries)[0]?.title).toBe("Gewicht");
  });

  it("drops what does not match", () => {
    expect(rankEntries("labs", [e("Sleep"), e("Weight")])).toEqual([]);
  });
});
