/**
 * The quick-entry chip filter: a long symptom row narrows by name, and a
 * picked symptom stays in view while the person looks for the next.
 *
 * Mutation checks (each run, each seen red):
 *   - drop the `picked` arm → "keeps a picked chip the text does not match"
 *     goes red;
 *   - compare case-sensitively → "matches any part of the name, any case"
 *     goes red.
 */
import { describe, expect, it } from "vitest";

import { filterSymptomChips } from "../symptom-chip-filter";

const LIST = [
  { id: "a", label: "Aura" },
  { id: "h", label: "Headache" },
  { id: "n", label: "Nausea" },
  { id: "u", label: null },
];

describe("filterSymptomChips", () => {
  it("keeps every chip while the field is blank", () => {
    expect(filterSymptomChips(LIST, "  ", [])).toEqual(LIST);
  });

  it("matches any part of the name, any case", () => {
    expect(filterSymptomChips(LIST, "hEAD", []).map((d) => d.id)).toEqual([
      "h",
    ]);
  });

  it("keeps a picked chip the text does not match", () => {
    expect(filterSymptomChips(LIST, "nau", ["a"]).map((d) => d.id)).toEqual([
      "a",
      "n",
    ]);
  });

  it("finds nothing for text no name holds", () => {
    expect(filterSymptomChips(LIST, "zzz", [])).toEqual([]);
  });
});
