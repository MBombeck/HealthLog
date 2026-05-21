import { describe, it, expect } from "vitest";
import {
  buildUserPrompt,
  buildComparisonBlock,
  type ComparisonSnapshot,
} from "@/lib/ai/prompts/insight-system-prompt";

/**
 * v1.4.16 phase B8 — comparison context block in the user prompt.
 *
 * When the dashboard's comparison toggle is active, the route layer
 * passes a `ComparisonSnapshot` to `buildUserPrompt()` so the LLM has
 * the prior-period numbers needed to narrate "Your average BP
 * improved by 4 mmHg vs. last month".
 */

const monthlySnapshot: ComparisonSnapshot = {
  baseline: "lastMonth",
  metrics: [
    {
      type: "BLOOD_PRESSURE_SYS",
      currentAvg: 128,
      baselineAvg: 132,
      delta: -4,
      deltaPercent: -3,
      unit: "mmHg",
    },
    {
      type: "WEIGHT",
      currentAvg: 80.4,
      baselineAvg: 82.7,
      delta: -2.3,
      deltaPercent: -2.8,
      unit: "kg",
    },
  ],
};

describe("buildUserPrompt() — comparison block (B8)", () => {
  it("appends NO comparison block when comparison is undefined", () => {
    const prompt = buildUserPrompt('{"weight":[]}', "agg", "en");
    expect(prompt).not.toMatch(/COMPARISON MODE/i);
    expect(prompt).not.toMatch(/VERGLEICHSMODUS/i);
  });

  it("appends an English comparison block when comparison is supplied with locale=en", () => {
    const prompt = buildUserPrompt(
      '{"weight":[]}',
      "agg",
      "en",
      monthlySnapshot,
    );
    expect(prompt).toMatch(/COMPARISON MODE ACTIVE/);
    expect(prompt).toMatch(/30 days ago/);
    expect(prompt).toContain("BLOOD_PRESSURE_SYS");
    expect(prompt).toContain("delta -4.0 mmHg");
    expect(prompt).toContain("WEIGHT");
    expect(prompt).toContain("delta -2.3 kg");
  });

  it("appends a German comparison block when locale=de", () => {
    const prompt = buildUserPrompt(
      '{"gewicht":[]}',
      "agg",
      "de",
      monthlySnapshot,
    );
    expect(prompt).toMatch(/VERGLEICHSMODUS AKTIV/);
    expect(prompt).toMatch(/30 Tage zuvor/);
    expect(prompt).toContain("BLOOD_PRESSURE_SYS");
  });

  it("uses 365-day language for the lastYear baseline", () => {
    const yearly: ComparisonSnapshot = {
      baseline: "lastYear",
      metrics: [
        {
          type: "WEIGHT",
          currentAvg: 80,
          baselineAvg: 85,
          delta: -5,
          deltaPercent: -5.9,
          unit: "kg",
        },
      ],
    };
    const en = buildUserPrompt("{}", "agg", "en", yearly);
    const de = buildUserPrompt("{}", "agg", "de", yearly);
    expect(en).toMatch(/365 days ago/);
    expect(de).toMatch(/365 Tage zuvor/);
  });

  it("renders an empty-metrics fallback that tells the model to say so", () => {
    const empty: ComparisonSnapshot = {
      baseline: "lastMonth",
      metrics: [],
    };
    const block = buildComparisonBlock("en", empty);
    expect(block).toMatch(
      /no metric currently has enough prior-period data to compare/,
    );
  });

  it("instructs the model that the most-significant delta must appear in the summary's first sentence", () => {
    const block = buildComparisonBlock("en", monthlySnapshot);
    expect(block).toMatch(/MUST appear in the summary['’]s\s+first sentence/);
  });

  it("never instructs the model to invent comparison numbers (anti-hallucination guard)", () => {
    const en = buildComparisonBlock("en", monthlySnapshot);
    const de = buildComparisonBlock("de", monthlySnapshot);
    expect(en).toMatch(/Do NOT invent comparison numbers/);
    expect(de).toMatch(/Erfinde KEINE Vergleichszahlen/);
  });

  it("flags missing-prior-period metrics with 'no prior-period data available'", () => {
    const partial: ComparisonSnapshot = {
      baseline: "lastMonth",
      metrics: [
        {
          type: "MOOD",
          currentAvg: 4,
          baselineAvg: null,
          delta: null,
          deltaPercent: null,
          unit: "/5",
        },
      ],
    };
    const block = buildComparisonBlock("en", partial);
    expect(block).toMatch(/MOOD: no prior-period data available/);
  });
});
