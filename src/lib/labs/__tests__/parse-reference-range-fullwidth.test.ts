import { describe, expect, it } from "vitest";

import { parseReferenceRange } from "@/lib/labs/parse-reference-range";

/**
 * A reference window printed in Chinese or Japanese arrives in the fullwidth
 * block: "３．５～５．０". Before the fullwidth fold the parser matched no
 * number there at all, so the window was stored and the reading was then
 * judged against no band, with nothing saying why — the failure mode
 * `isUnreadableRange` exists to name.
 *
 * The fold is for matching only: `text` stays exactly what the report printed,
 * so a later reader still sees the digits the lab set.
 */
describe("parseReferenceRange — fullwidth notation", () => {
  it.each([
    ["３．５～５．０", 3.5, 5],
    ["３．５〜５．０", 3.5, 5],
    ["3.5〜5.0", 3.5, 5],
    ["３．５－５．０", 3.5, 5],
    ["３．５－５．０ ｍｍｏｌ／Ｌ", 3.5, 5],
    ["＜５．０", null, 5],
    ["＜＝５．０", null, 5],
  ])("reads %s as %s..%s", (raw, low, high) => {
    expect(parseReferenceRange(raw)).toEqual({ low, high, text: raw });
  });

  it("keeps the printed string, not the folded one", () => {
    expect(parseReferenceRange("３．５～５．０")?.text).toBe("３．５～５．０");
  });

  it("still reads the halfwidth notations it read before", () => {
    // The fold must not change a window that already worked: the Korean sheet's
    // "3.5~5.0" and the plain ASCII one are the regression case.
    expect(parseReferenceRange("3.5~5.0")).toEqual({
      low: 3.5,
      high: 5,
      text: "3.5~5.0",
    });
    expect(parseReferenceRange("3.5 - 5.0")).toEqual({
      low: 3.5,
      high: 5,
      text: "3.5 - 5.0",
    });
  });
});

describe("parseReferenceRange — outside what the fullwidth fold claims", () => {
  it("a bare fullwidth number is still not a window", () => {
    expect(parseReferenceRange("３．５")).toEqual({
      low: null,
      high: null,
      text: "３．５",
    });
  });

  it("U+2266 is not a wide rendering, and has no bound prefix either", () => {
    expect(parseReferenceRange("≦５．０")).toEqual({
      low: null,
      high: null,
      text: "≦５．０",
    });
  });

  it("a Chinese bound word needs the prose table, not this fold", () => {
    expect(parseReferenceRange("５．０以下")).toEqual({
      low: null,
      high: null,
      text: "５．０以下",
    });
  });
});
