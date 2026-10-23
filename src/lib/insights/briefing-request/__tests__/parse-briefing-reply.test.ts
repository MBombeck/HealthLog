/**
 * A reply that fits the insight schema keeps the blocks the prompt asks for
 * beside it. The strict object used to drop `dailyBriefing` from exactly the
 * replies that validated.
 */
import { describe, expect, it } from "vitest";

import { parseBriefingReply } from "../grounding";

const VALID = {
  summary: "Steady week.",
  classification: "gut",
  findings: [],
  correlations: [],
  recommendations: [],
  dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
  disclaimer: "Consult your doctor.",
};

const BLOCKS = {
  dailyBriefing: { paragraph: "Readings held steady.", signalsOfDay: [] },
  trendAnnotations: [{ metric: "weight", note: "flat" }],
  storyboardAnnotations: [],
};

describe("parseBriefingReply", () => {
  it("keeps the briefing blocks of a reply that validates", () => {
    const parsed = parseBriefingReply(JSON.stringify({ ...VALID, ...BLOCKS }));
    expect(parsed).toMatchObject(BLOCKS);
    expect(parsed).toMatchObject({ summary: "Steady week." });
  });

  it("keeps a reply that does not validate as it was parsed", () => {
    const loose = { summary: "No classification.", ...BLOCKS };
    expect(parseBriefingReply(JSON.stringify(loose))).toEqual(loose);
  });
});
