import { describe, expect, it } from "vitest";

import { compactSections } from "../prompt-compact";

describe("compactSections", () => {
  it("drops empty arrays", () => {
    const out = compactSections({ sleep: [], weight: [{ v: 1 }] });
    expect(out).toEqual({ weight: [{ v: 1 }] });
  });

  it("drops empty plain objects", () => {
    const out = compactSections({ medications: {}, weight: { latest: 82 } });
    expect(out).toEqual({ weight: { latest: 82 } });
  });

  it("drops undefined values", () => {
    const out = compactSections({ weight: undefined, bp: { avg: 128 } });
    expect(out).toEqual({ bp: { avg: 128 } });
  });

  it("preserves null (null is a meaningful 'unknown' marker, not 'empty')", () => {
    const out = compactSections({ avg30: null, avg7: 82 });
    expect(out).toEqual({ avg30: null, avg7: 82 });
  });

  it("preserves nested objects shallow by default (count: 0 stays)", () => {
    const out = compactSections({
      coverage: { count: 0, spanDays: 0 },
      bp: { avg30: 128 },
    });
    expect(out.coverage).toEqual({ count: 0, spanDays: 0 });
  });

  it("deep mode recurses into nested plain objects", () => {
    const out = compactSections(
      {
        bp: { avg30: 128, history: [] },
        ghost: { medications: [] },
      },
      { deep: true },
    );
    expect(out).toEqual({ bp: { avg30: 128 } });
  });

  it("preserves arrays of objects with content", () => {
    const out = compactSections({
      medications: [{ name: "Mounjaro" }],
      bp: [],
    });
    expect(out).toEqual({ medications: [{ name: "Mounjaro" }] });
  });

  it("returns a new object — does not mutate the input", () => {
    const input = { sleep: [], weight: 82 } as Record<string, unknown>;
    const out = compactSections(input);
    expect(input.sleep).toEqual([]);
    expect(out).not.toBe(input);
  });

  it("renders empty input as empty output", () => {
    expect(compactSections({})).toEqual({});
  });

  it("does not drop primitive zeros, false, or empty strings", () => {
    // These are legitimate data signals — only structural emptiness
    // (empty arrays/objects/undefined) is filtered.
    const out = compactSections({
      count: 0,
      enabled: false,
      label: "",
    });
    expect(out).toEqual({ count: 0, enabled: false, label: "" });
  });
});
