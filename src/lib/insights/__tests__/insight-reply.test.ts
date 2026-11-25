/**
 * The one reply parser both generation paths share. A reply that fits the
 * insight schema keeps the blocks the prompt asks for beside it (the strict
 * object used to drop `dailyBriefing` from exactly the replies that
 * validated), and a reply whose briefing the card cannot render is refused
 * instead of passed on as a success (#1499).
 */
import { describe, expect, it } from "vitest";

import { parseInsightReply } from "../insight-reply";

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
  dailyBriefing: {
    paragraph: "Readings held steady.",
    signalsOfDay: [],
    keyFindings: [],
  },
  trendAnnotations: { weight: "Flat over the month." },
  storyboardAnnotations: [],
};

const OPTIONAL = { briefingRequired: false };

describe("parseInsightReply", () => {
  it("keeps the briefing blocks of a reply that validates", () => {
    const parsed = parseInsightReply(
      JSON.stringify({ ...VALID, ...BLOCKS }),
      OPTIONAL,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.insights).toMatchObject(BLOCKS);
    expect(parsed.insights).toMatchObject({ summary: "Steady week." });
  });

  it("keeps a reply that does not validate as it was parsed", () => {
    const loose = { summary: "No classification.", ...BLOCKS };
    const parsed = parseInsightReply(JSON.stringify(loose), OPTIONAL);
    expect(parsed).toEqual({ ok: true, insights: loose, repairs: [] });
  });

  it("strips a markdown fence before parsing", () => {
    const parsed = parseInsightReply(
      "```json\n" + JSON.stringify({ ...VALID, ...BLOCKS }) + "\n```",
      OPTIONAL,
    );
    expect(parsed.ok).toBe(true);
  });

  it("refuses a reply that is not a JSON object", () => {
    for (const content of ["Sure! Here it is.", "[1, 2]", "42"]) {
      expect(parseInsightReply(content, OPTIONAL)).toMatchObject({
        ok: false,
        reason: "invalid-json",
      });
    }
  });

  it("refuses a valid JSON reply whose briefing the card cannot render", () => {
    const parsed = parseInsightReply(
      JSON.stringify({ ...VALID, dailyBriefing: { keyFindings: [] } }),
      OPTIONAL,
    );
    expect(parsed).toMatchObject({ ok: false, reason: "invalid-briefing" });
  });

  it("refuses a missing briefing only when one was required", () => {
    const content = JSON.stringify(VALID);
    expect(parseInsightReply(content, OPTIONAL).ok).toBe(true);
    expect(
      parseInsightReply(content, { briefingRequired: true }),
    ).toMatchObject({ ok: false, reason: "invalid-briefing" });
  });

  it("drops trend annotations the card would not show", () => {
    const parsed = parseInsightReply(
      JSON.stringify({ ...VALID, ...BLOCKS, trendAnnotations: ["flat"] }),
      OPTIONAL,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.insights).not.toHaveProperty("trendAnnotations");
    expect(parsed.repairs).toContain("trend-annotations-dropped");
  });
});
