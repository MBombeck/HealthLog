import { describe, expect, it } from "vitest";

import {
  classifyReferenceRange,
  formatReferenceRange,
  priorityReferenceRangeStatus,
} from "@/lib/labs/reference-range";

describe("classifyReferenceRange", () => {
  it("is unknown when no bounds are reported", () => {
    expect(classifyReferenceRange(5, null, null)).toBe("unknown");
    expect(classifyReferenceRange(5, undefined, undefined)).toBe("unknown");
  });

  it("treats both bounds as inclusive", () => {
    expect(classifyReferenceRange(4, 4, 6)).toBe("in-range");
    expect(classifyReferenceRange(6, 4, 6)).toBe("in-range");
    expect(classifyReferenceRange(5, 4, 6)).toBe("in-range");
  });

  it("flags below / above the full range", () => {
    expect(classifyReferenceRange(3.9, 4, 6)).toBe("below");
    expect(classifyReferenceRange(6.1, 4, 6)).toBe("above");
  });

  it("classifies against a high-only bound", () => {
    expect(classifyReferenceRange(100, null, 116)).toBe("in-range");
    expect(classifyReferenceRange(120, null, 116)).toBe("above");
  });

  it("classifies against a low-only bound", () => {
    expect(classifyReferenceRange(8, 10, null)).toBe("below");
    expect(classifyReferenceRange(12, 10, null)).toBe("in-range");
  });
});

describe("formatReferenceRange", () => {
  // An identity-ish formatter keeps the structure assertions readable.
  const fmt = (n: number) => String(n);

  it("renders a full low–high range with an en-dash and no spaces", () => {
    expect(formatReferenceRange(4, 6, fmt)).toBe("4–6");
  });

  it("renders a high-only bound with ≤", () => {
    expect(formatReferenceRange(null, 116, fmt)).toBe("≤ 116");
  });

  it("renders a low-only bound with ≥", () => {
    expect(formatReferenceRange(10, null, fmt)).toBe("≥ 10");
  });

  it("returns the empty string for no bounds by default", () => {
    expect(formatReferenceRange(null, null, fmt)).toBe("");
    expect(formatReferenceRange(undefined, undefined, fmt)).toBe("");
  });

  it("honours a custom emptyText for the no-bounds case", () => {
    expect(formatReferenceRange(null, null, fmt, { emptyText: "—" })).toBe("—");
  });

  it("defers digit formatting entirely to the callback", () => {
    const oneDecimal = (n: number) => n.toFixed(1);
    expect(formatReferenceRange(4, 6, oneDecimal)).toBe("4.0–6.0");
  });
});

describe("priorityReferenceRangeStatus", () => {
  it("implements canonical priority: above > below > in-range > unknown with counts", () => {
    expect(
      priorityReferenceRangeStatus({
        above: 1,
        below: 1,
        inRange: 1,
        unknown: 1,
      }),
    ).toBe("above");
    expect(
      priorityReferenceRangeStatus({
        above: 0,
        below: 2,
        inRange: 5,
        unknown: 1,
      }),
    ).toBe("below");
    expect(
      priorityReferenceRangeStatus({
        above: 0,
        below: 0,
        inRange: 3,
        unknown: 2,
      }),
    ).toBe("in-range");
    expect(
      priorityReferenceRangeStatus({
        above: 0,
        below: 0,
        inRange: 0,
        unknown: 4,
      }),
    ).toBe("unknown");
    expect(
      priorityReferenceRangeStatus({
        above: 0,
        below: 0,
        inRange: 0,
        unknown: 0,
      }),
    ).toBe("unknown");
  });
});
