import { describe, expect, it } from "vitest";

import { plainSeparators } from "../plain-separators";

describe("plainSeparators", () => {
  it("turns a spaced dash between clauses into a comma", () => {
    expect(
      plainSeparators(
        "There is nothing here that needs fixing — the work now is the rhythm.",
      ),
    ).toBe(
      "There is nothing here that needs fixing, the work now is the rhythm.",
    );
    expect(plainSeparators("Steady – keep going")).toBe("Steady, keep going");
  });

  it("turns a spaced middle dot into a comma", () => {
    expect(plainSeparators("Sleep 7.5 h · HRV 55 ms")).toBe(
      "Sleep 7.5 h, HRV 55 ms",
    );
  });

  it("turns an em dash set between two words into a comma", () => {
    expect(plainSeparators("a stable place—worth protecting")).toBe(
      "a stable place, worth protecting",
    );
  });

  it("leaves ranges, units and negative figures alone", () => {
    expect(plainSeparators("Typical for you: 97.2–99.8")).toBe(
      "Typical for you: 97.2–99.8",
    );
    expect(plainSeparators("Mon–Fri")).toBe("Mon–Fri");
    expect(plainSeparators("49.0 mL/(kg·min)")).toBe("49.0 mL/(kg·min)");
    expect(plainSeparators("down by −2 kg")).toBe("down by −2 kg");
  });

  it("keeps the punctuation a dash stood in front of", () => {
    expect(plainSeparators("Held steady — .")).toBe("Held steady.");
  });

  it("works inside a JSON reply without touching its structure", () => {
    const raw = '{"headline":"Calm week — nothing to change","n":3}';
    expect(JSON.parse(plainSeparators(raw))).toEqual({
      headline: "Calm week, nothing to change",
      n: 3,
    });
  });

  it("keeps Russian dashes, which carry grammar there, but not the dot", () => {
    expect(plainSeparators("Сводка за неделю — всё спокойно · 3 дня")).toBe(
      "Сводка за неделю — всё спокойно, 3 дня",
    );
  });

  it("leaves text without a separator exactly as it came", () => {
    expect(plainSeparators("Items: a, b, ... and more")).toBe(
      "Items: a, b, ... and more",
    );
  });

  it("returns an empty reply as it came", () => {
    expect(plainSeparators("")).toBe("");
  });
});
