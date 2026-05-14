import { describe, expect, it } from "vitest";

import { parseDoseMg, parseDoseMgOrNull } from "../dose-string";

describe("parseDoseMg", () => {
  it("parses standard 'X mg' strings", () => {
    expect(parseDoseMg("7.5 mg")).toBe(7.5);
    expect(parseDoseMg("15 mg")).toBe(15);
    expect(parseDoseMg("0.25 mg")).toBe(0.25);
  });

  it("accepts comma as decimal separator for German locale input", () => {
    expect(parseDoseMg("12,5 mg")).toBe(12.5);
    expect(parseDoseMg("0,25")).toBe(0.25);
  });

  it("returns NaN on unparseable input", () => {
    expect(Number.isNaN(parseDoseMg(""))).toBe(true);
    expect(Number.isNaN(parseDoseMg("as needed"))).toBe(true);
    expect(Number.isNaN(parseDoseMg("mg"))).toBe(true);
  });

  it("extracts the first number when units precede / follow", () => {
    expect(parseDoseMg("dose: 2.5 mg")).toBe(2.5);
    expect(parseDoseMg("2.5mg")).toBe(2.5);
  });

  it("strips leading whitespace when the regex picks the number", () => {
    expect(parseDoseMg("   5 mg")).toBe(5);
  });
});

describe("parseDoseMgOrNull", () => {
  it("returns the numeric value when parseable", () => {
    expect(parseDoseMgOrNull("7.5 mg")).toBe(7.5);
    expect(parseDoseMgOrNull("0,5")).toBe(0.5);
  });

  it("returns null on unparseable input rather than NaN", () => {
    expect(parseDoseMgOrNull("")).toBeNull();
    expect(parseDoseMgOrNull("as needed")).toBeNull();
    expect(parseDoseMgOrNull("mg")).toBeNull();
  });

  it("returns null when the numeric portion is non-finite", () => {
    // Defence-in-depth — Number.parseFloat itself never returns
    // Infinity from this regex, but the guard belongs to the helper
    // contract.
    expect(parseDoseMgOrNull("not a dose")).toBeNull();
  });

  it("preserves zero as a valid dose (not null) when the user logs 0 mg", () => {
    expect(parseDoseMgOrNull("0 mg")).toBe(0);
  });
});
