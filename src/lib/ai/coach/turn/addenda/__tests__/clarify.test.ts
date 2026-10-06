import { describe, expect, it } from "vitest";

import { clarifyAddendum } from "../clarify";
import { parseClarifySentinel } from "@/lib/ai/coach/clarify";

describe("clarifyAddendum", () => {
  it.each(["en", "de"] as const)("states the limits (%s)", (locale) => {
    const text = clarifyAddendum(locale);
    expect(text).toContain("---CLARIFY---");
    expect(text).toContain("---END---");
    for (const w of [
      "last7days",
      "last30days",
      "last90days",
      "lastYear",
      "allTime",
    ]) {
      expect(text).toContain(w);
    }
  });

  it("uses English for every locale, like the other addenda", () => {
    expect(clarifyAddendum("fr")).toBe(clarifyAddendum("en"));
    expect(clarifyAddendum("de")).toBe(clarifyAddendum("en"));
  });

  it("stays short: it rides every tool-mode round", () => {
    // About 450 tokens at four characters a token: the v1.41 triggers and
    // the tool rules on top of the sentinel fallback.
    expect(clarifyAddendum("en").length).toBeLessThan(1_800);
  });

  it("asks through the tool, and only on the listed triggers", () => {
    const text = clarifyAddendum("en");
    expect(text).toContain("ask_clarification");
    expect(text).toMatch(/visibly depends/);
    expect(text).toMatch(/round two/);
    expect(text).toMatch(/Otherwise do not ask/);
  });

  it("teaches a block the parser accepts", () => {
    // The example in the prompt must be one the server turns into a card.
    const example = clarifyAddendum("en").match(
      /---CLARIFY---[\s\S]*?---END---/,
    )![0];
    const out = parseClarifySentinel({
      prose: `Which pulse do you mean?\n${example}`,
      inventory: ["pulse", "resting_hr", "walking_hr"].map((metric) => ({
        tool: "get_metric_series",
        metric,
        domain: metric,
        present: true,
      })),
      locale: "en",
    });
    expect(out.clarification?.choices).toHaveLength(3);
  });
});
