import { describe, it, expect } from "vitest";
import { isValidKvnr, normaliseKvnr } from "../kvnr";

describe("isValidKvnr", () => {
  // Synthetic KVNRs with a correctly computed mod-10 check digit.
  it.each(["A123456780", "Z000000005", "M987654323"])(
    "accepts a well-formed KVNR with a valid check digit (%s)",
    (kvnr) => {
      expect(isValidKvnr(kvnr)).toBe(true);
    },
  );

  it("rejects a KVNR with a wrong check digit", () => {
    // A123456780 is valid; bump the check digit to break it.
    expect(isValidKvnr("A123456781")).toBe(false);
    expect(isValidKvnr("Z000000000")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(isValidKvnr("")).toBe(false);
    expect(isValidKvnr("123456789")).toBe(false); // no leading letter
    expect(isValidKvnr("a123456780")).toBe(false); // lowercase letter
    expect(isValidKvnr("A12345678")).toBe(false); // too short
    expect(isValidKvnr("A1234567890")).toBe(false); // too long
    expect(isValidKvnr("AB23456780")).toBe(false); // two letters
    expect(isValidKvnr("A12345678X")).toBe(false); // non-digit check pos
  });

  it("is total — never throws on odd input", () => {
    // @ts-expect-error deliberate wrong type
    expect(isValidKvnr(null)).toBe(false);
    // @ts-expect-error deliberate wrong type
    expect(isValidKvnr(undefined)).toBe(false);
  });
});

describe("normaliseKvnr", () => {
  it("strips whitespace and uppercases", () => {
    expect(normaliseKvnr("  a123 456 780 ")).toBe("A123456780");
  });
});
