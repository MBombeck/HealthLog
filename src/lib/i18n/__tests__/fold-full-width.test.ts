import { describe, expect, it } from "vitest";

import { foldFullWidthToAscii } from "@/lib/i18n/fold-for-match";

/**
 * A report printed in Chinese or Japanese sets ASCII in the fullwidth block:
 * the digits, the decimal dot, the range hyphen, the unit's slash, the percent
 * sign. Each of those means exactly what its ASCII twin means, which is what
 * makes folding them a spelling tolerance rather than a translation — and what
 * keeps the fold off the marks that do NOT: "、" and "。" are their own
 * punctuation, not a wide rendering of "," and ".".
 */
describe("foldFullWidthToAscii", () => {
  it.each([
    ["３．５", "3.5"],
    ["３．５～５．０", "3.5~5.0"],
    ["３．５－５．０", "3.5-5.0"],
    ["ｍｍｏｌ／Ｌ", "mmol/L"],
    ["ｍｇ／ｄＬ", "mg/dL"],
    ["７０％", "70%"],
    ["＜５", "<5"],
    ["１０＾９／Ｌ", "10^9/L"],
  ])("folds %s to %s", (raw, expected) => {
    expect(foldFullWidthToAscii(raw)).toBe(expected);
  });

  it("folds every codepoint of the block, in one pass", () => {
    const ascii = Array.from({ length: 0x5e - 0x21 + 1 }, (_, i) =>
      String.fromCharCode(0x21 + i),
    ).join("");
    const wide = Array.from(ascii, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) + 0xfee0),
    ).join("");
    expect(foldFullWidthToAscii(wide)).toBe(ascii);
  });

  it("turns the ideographic space into an ordinary one", () => {
    expect(foldFullWidthToAscii("140\u3000100")).toBe("140 100");
  });

  it("leaves Han, Kana and CJK punctuation alone", () => {
    for (const raw of ["血圧", "コレステロール", "基準値。", "「正常」"]) {
      expect(foldFullWidthToAscii(raw), raw).toBe(raw);
    }
  });

  it("keeps the ideographic comma a comma", () => {
    // U+3001 is not a wide ","; folding it would join two list items into one.
    expect(foldFullWidthToAscii("３．５、５．０")).toBe("3.5、5.0");
  });

  it("does not follow NFKC into compatibility characters", () => {
    // Each of these has an ASCII-ish compatibility decomposition NFKC would
    // apply. They are not fullwidth renderings of ASCII, and a fold that
    // rewrote them would be the transliteration this module refuses to be.
    for (const raw of ["≦", "①", "㈱", "㎡"]) {
      expect(foldFullWidthToAscii(raw), raw).toBe(raw);
    }
    // The comparison sign survives while the digit beside it still folds —
    // which is the whole point: fold the rendering, not the meaning.
    expect(foldFullWidthToAscii("≦５")).toBe("≦5");
  });

  it("is idempotent and leaves ASCII untouched", () => {
    expect(foldFullWidthToAscii("3.5-5.0")).toBe("3.5-5.0");
    expect(foldFullWidthToAscii(foldFullWidthToAscii("３．５"))).toBe("3.5");
  });
});
