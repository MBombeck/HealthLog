/**
 * The detection behind `e2e/no-repeated-text.spec.ts`, fed a fixture.
 *
 * The spec runs in a browser against seeded pages, where a green run can mean
 * "nothing repeats" or "the collector saw nothing". This pins the first
 * reading: a page that says the same sentence twice, or titles a card like
 * the page, is found, and a page with too little text is refused rather than
 * passed.
 */
import { describe, expect, it } from "vitest";

import { findRepeats, type TextBlock } from "../../e2e/utils/repeated-text";

const block = (text: string, kind = "p"): TextBlock => ({ text, kind });

const PAGE: TextBlock[] = [
  block("Vaccinations", "h1"),
  block("Your immunization record, dose by dose."),
  block("No vaccination recorded yet", "empty-state-title"),
  block("Your  immunization record, dose by dose. ", "card-description"),
  block("Add vaccination", "button"),
  block("Tetanus", "h2"),
];

describe("no-repeated-text detection", () => {
  it("finds a sentence that stands twice, whitespace and case aside", () => {
    const report = findRepeats(PAGE, "Vaccinations", []);
    expect(report.repeats).toEqual([
      {
        text: "Your immunization record, dose by dose.",
        count: 2,
        kinds: ["p", "card-description"],
      },
    ]);
    expect(report.tooFew).toBe(false);
  });

  it("lets short labels repeat: a unit or a two-word button is not a block", () => {
    const report = findRepeats(
      [
        ...PAGE.slice(0, 3),
        block("Add vaccination"),
        block("Add vaccination"),
        block("mmHg"),
        block("mmHg"),
        block("11/28/2026, 04:05 AM"),
        block("11/28/2026, 04:05 AM"),
      ],
      null,
      [],
    );
    expect(report.repeats).toEqual([]);
  });

  it("finds a card title that is the page title again", () => {
    const report = findRepeats(PAGE, "Blood pressure", [
      block("Blood pressure", "card-title"),
      block("By time of day", "h2"),
    ]);
    expect(report.titleEchoes).toEqual(["card-title: Blood pressure"]);
  });

  it("refuses to pass a page it could not read", () => {
    expect(findRepeats(PAGE.slice(0, 1), "Vaccinations", []).tooFew).toBe(true);
    expect(findRepeats([], null, []).tooFew).toBe(true);
  });
});
