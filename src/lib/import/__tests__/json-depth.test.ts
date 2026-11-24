import { describe, expect, it } from "vitest";

import { jsonDeeperThan, UPLOADED_JSON_MAX_DEPTH } from "../json-depth";

const nested = (depth: number) =>
  JSON.parse(`${"[".repeat(depth)}${"]".repeat(depth)}`) as unknown;

describe("jsonDeeperThan", () => {
  it("counts the value itself as the first level", () => {
    expect(jsonDeeperThan(nested(3), 3)).toBe(false);
    expect(jsonDeeperThan(nested(4), 3)).toBe(true);
    expect(jsonDeeperThan({ a: { b: [1, { c: null }] } }, 4)).toBe(false);
    expect(jsonDeeperThan({ a: { b: [1, { c: {} }] } }, 4)).toBe(true);
  });

  it("treats scalars and null as no depth", () => {
    for (const v of [null, 1, "x", true])
      expect(jsonDeeperThan(v, 0)).toBe(false);
  });

  it("walks a document deeper than the stack without overflowing", () => {
    expect(jsonDeeperThan(nested(500_000))).toBe(true);
    expect(jsonDeeperThan(nested(UPLOADED_JSON_MAX_DEPTH))).toBe(false);
  });
});
