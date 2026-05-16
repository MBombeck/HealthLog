import { describe, it, expect } from "vitest";
import { toJson } from "../db";

// `toJson` is a typed no-op cast that re-types a value as
// `Prisma.InputJsonValue`. The runtime behaviour is identity; the
// guarantee being tested is that the exported helper exists, accepts
// every JSON-serialisable shape we throw at it, and never mutates or
// clones the value.
describe("toJson", () => {
  it("is exported and callable", () => {
    expect(typeof toJson).toBe("function");
  });

  it("returns the same reference for objects (identity cast)", () => {
    const value = { a: 1, nested: { b: "x" } };
    expect(toJson(value)).toBe(value);
  });

  it("returns the same reference for arrays", () => {
    const value = [1, 2, 3];
    expect(toJson(value)).toBe(value);
  });

  it("accepts primitives", () => {
    expect(toJson(42)).toBe(42);
    expect(toJson("hello")).toBe("hello");
    expect(toJson(true)).toBe(true);
    expect(toJson(null)).toBeNull();
  });

  it("accepts typed application shapes (Record, interface-like)", () => {
    const prefs: Record<string, boolean> = { mood: true, weight: false };
    const round = toJson(prefs);
    expect(round).toBe(prefs);
    expect(round).toEqual({ mood: true, weight: false });
  });

  it("accepts nested mixed shapes (the production payloads)", () => {
    const payload = {
      version: 1,
      widgets: [{ id: "weight", visible: true, order: 0 }],
      chartOverlayPrefs: {
        weight: {
          showTrendIndicator: true,
          showTrendArrow: false,
          showTargetRange: true,
        },
      },
    };
    expect(toJson(payload)).toBe(payload);
  });
});
