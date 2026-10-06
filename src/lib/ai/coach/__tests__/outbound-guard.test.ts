import { describe, it, expect } from "vitest";

import type { Locale } from "@/lib/i18n/config";

import {
  screenCoachReply,
  coachOutboundFallback,
  COACH_OUTBOUND_DOSE_BLOCK_EN,
  COACH_OUTBOUND_DOSE_BLOCK_DE,
  COACH_OUTBOUND_RISK_BLOCK_EN,
} from "@/lib/ai/coach/outbound-guard";

describe("screenCoachReply — dose-prescription", () => {
  const blocked: Array<[string, Locale]> = [
    ["You should step up to 2.4 mg next week.", "en"],
    ["Consider increasing to 10 mg.", "en"],
    ["I'd recommend a 0.5 mg dose to start.", "en"],
    ["Erhöhe auf 7,5 mg, sobald du dich daran gewöhnt hast.", "de"],
    ["Du kannst die nächste Stufe 5 mg ausprobieren.", "de"],
    ["Lower your dose to 1.0 mg.", "en"],
  ];
  for (const [reply, locale] of blocked) {
    it(`blocks: ${reply.slice(0, 32)}`, () => {
      const d = screenCoachReply(reply, locale);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });
  }

  const allowed: Array<[string, Locale]> = [
    ["You're on week 3 of 7.5 mg, and your weight is tracking down.", "en"],
    ["Your snapshot shows you take 5 mg daily — adherence looks steady.", "en"],
    [
      "Dein Snapshot zeigt 7,5 mg in Woche 3 — die Einnahmetreue ist gut.",
      "de",
    ],
    ["Talk to your prescriber about whether your dose is still right.", "en"],
  ];
  for (const [reply, locale] of allowed) {
    it(`allows factual mention: ${reply.slice(0, 32)}`, () => {
      expect(screenCoachReply(reply, locale).block).toBe(false);
    });
  }
});

describe("screenCoachReply — risk score", () => {
  const blocked: Array<[string, Locale]> = [
    ["Your 10-year cardiovascular risk is about 12%.", "en"],
    ["That puts your stroke risk at 8%.", "en"],
    ["Your ASCVD score suggests elevated risk.", "en"],
    ["Dein 10-Jahres-Risiko liegt bei etwa 14%.", "de"],
    ["Das ergibt ein Risiko von 12% in den nächsten Jahren.", "de"],
  ];
  for (const [reply, locale] of blocked) {
    it(`blocks: ${reply.slice(0, 32)}`, () => {
      const d = screenCoachReply(reply, locale);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    });
  }

  it("allows a plain percentage that is not a risk claim", () => {
    expect(
      screenCoachReply("Your adherence was 92% over the last 30 days.", "en")
        .block,
    ).toBe(false);
  });
});

// Issue #587 — a grounded Sleep Score explanation was replaced with the
// generic clinical-risk refusal because the named-risk-engine pattern
// matched bare "score", not just the SCORE2 risk calculator it was meant to
// name.
describe("screenCoachReply — issue #587 ordinary wellness-score wording", () => {
  const allowed = [
    "Your Sleep Score is based on sleep duration and stage balance — it's currently in a healthy range for you.",
    "Your Readiness Score is lower than your recent baseline, likely from the shorter sleep window.",
    "This Health Score is based on the available tracked pillars: BP, weight, mood, and compliance.",
  ];
  for (const reply of allowed) {
    it(`allows: ${reply.slice(0, 40)}`, () => {
      const d = screenCoachReply(reply, "en");
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }

  it("still blocks a reply naming the SCORE2 risk engine", () => {
    const d = screenCoachReply(
      "Based on SCORE2, your cardiovascular risk profile looks elevated.",
      "en",
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });
});

describe("screenCoachReply — clean replies", () => {
  it("passes a grounded, non-prescriptive reply", () => {
    const reply =
      "Your systolic is averaging 128 mmHg this week, 4 below your monthly mean. Nice and steady — keep the routine going.";
    expect(screenCoachReply(reply, "en").block).toBe(false);
  });
  it("passes an empty reply through (handled upstream)", () => {
    expect(screenCoachReply("", "en").block).toBe(false);
  });
});

describe("coachOutboundFallback", () => {
  it("returns localised dose-block copy", () => {
    expect(coachOutboundFallback("dose_prescription", "en")).toBe(
      COACH_OUTBOUND_DOSE_BLOCK_EN,
    );
    expect(coachOutboundFallback("dose_prescription", "de")).toBe(
      COACH_OUTBOUND_DOSE_BLOCK_DE,
    );
  });
  it("returns risk-block copy and rides EN for non-de locales", () => {
    expect(coachOutboundFallback("risk_score", "en")).toBe(
      COACH_OUTBOUND_RISK_BLOCK_EN,
    );
    expect(coachOutboundFallback("risk_score", "fr")).toBe(
      COACH_OUTBOUND_RISK_BLOCK_EN,
    );
  });
});

describe("screenCoachReply — a drug-named dose change", () => {
  it("replaces 'Increase your metformin to 2000 mg daily'", () => {
    const d = screenCoachReply(
      "Increase your metformin to 2000 mg daily.",
      "en",
      [1000],
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("passes a restatement of the logged schedule", () => {
    const d = screenCoachReply(
      "Your log shows you take 1000 mg twice daily.",
      "en",
      [1000],
    );
    expect(d.block).toBe(false);
  });
});
