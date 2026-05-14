import { describe, expect, it } from "vitest";

import { buildTargetPrompt } from "../target-prompts";
import { coachScopeForTarget } from "../target-scope";

/**
 * v1.4.25 W3e — per-card Coach prefill builder.
 *
 * Pin the per-metric template shape + the locale switch so a
 * refactor cannot silently flatten the prompts to a single fallback.
 */

describe("buildTargetPrompt", () => {
  const base = {
    current: 124,
    range: { min: 110, max: 130 },
    unit: "mmHg",
    status: "On target",
    streakDays: 5,
    daysInRange7d: 6,
  };

  it("returns the EN BP template with live values", () => {
    const out = buildTargetPrompt({
      type: "BLOOD_PRESSURE",
      locale: "en",
      ...base,
    });
    expect(out).toContain("blood pressure");
    expect(out).toContain("124 mmHg");
    expect(out).toContain("110–130 mmHg");
    expect(out).toContain("6 days");
    expect(out).toContain("5 days"); // streak
  });

  it("returns the DE BP template with live values", () => {
    const out = buildTargetPrompt({
      type: "BLOOD_PRESSURE",
      locale: "de",
      ...base,
    });
    expect(out).toContain("Blutdruck-Wert");
    expect(out).toContain("124 mmHg");
    expect(out).toContain("110–130 mmHg");
    expect(out).toContain("6 Tagen");
  });

  it("omits the streak fragment when streakDays < 3", () => {
    const out = buildTargetPrompt({
      type: "BLOOD_PRESSURE",
      locale: "en",
      ...base,
      streakDays: 2,
    });
    expect(out).not.toContain("current streak");
  });

  it("renders the MOOD_STABILITY verbal label inline", () => {
    const stableOut = buildTargetPrompt({
      type: "MOOD_STABILITY",
      locale: "en",
      ...base,
      current: 0.5,
      unit: "σ",
      range: { min: 0, max: 0.5 },
    });
    expect(stableOut).toContain("stable");
    const variableOut = buildTargetPrompt({
      type: "MOOD_STABILITY",
      locale: "en",
      ...base,
      current: 1.5,
      unit: "σ",
      range: { min: 0, max: 0.5 },
    });
    expect(variableOut).toContain("variable");
    const highOut = buildTargetPrompt({
      type: "MOOD_STABILITY",
      locale: "en",
      ...base,
      current: 2.5,
      unit: "σ",
      range: { min: 0, max: 0.5 },
    });
    expect(highOut).toContain("highly variable");
  });

  it("falls back to the general template for unknown target types", () => {
    const out = buildTargetPrompt({
      type: "FUTURE_METRIC_X",
      locale: "en",
      ...base,
    });
    expect(out).toContain("how I'm doing on");
    expect(out).toContain("future metric x");
  });

  it("DE fallback localises the question shape", () => {
    const out = buildTargetPrompt({
      type: "FUTURE_METRIC_X",
      locale: "de",
      ...base,
    });
    expect(out).toContain("Wie steht es um meine");
  });
});

describe("coachScopeForTarget", () => {
  it("maps WEIGHT + BMI to the weight source", () => {
    expect(coachScopeForTarget("WEIGHT")).toEqual(["weight"]);
    expect(coachScopeForTarget("BMI")).toEqual(["weight"]);
  });

  it("maps BLOOD_PRESSURE and BLOOD_PRESSURE_IN_TARGET to bp", () => {
    expect(coachScopeForTarget("BLOOD_PRESSURE")).toEqual(["bp"]);
    expect(coachScopeForTarget("BLOOD_PRESSURE_IN_TARGET")).toEqual(["bp"]);
  });

  it("maps mood + stability to the mood source", () => {
    expect(coachScopeForTarget("MOOD_SCORE")).toEqual(["mood"]);
    expect(coachScopeForTarget("MOOD_STABILITY")).toEqual(["mood"]);
  });

  it("returns an empty array for unmapped targets (use defaults)", () => {
    expect(coachScopeForTarget("BLOOD_GLUCOSE_FASTING")).toEqual([]);
    expect(coachScopeForTarget("BODY_FAT")).toEqual([]);
    expect(coachScopeForTarget("FUTURE_X")).toEqual([]);
  });
});
