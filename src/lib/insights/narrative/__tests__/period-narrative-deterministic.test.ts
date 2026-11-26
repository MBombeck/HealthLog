import { describe, it, expect } from "vitest";

import { buildDeterministicNarrative } from "@/lib/insights/narrative/period-narrative-deterministic";
import type { PeriodNarrativeContext } from "@/lib/insights/narrative/period-narrative";

function ctx(
  over: Partial<PeriodNarrativeContext> = {},
): PeriodNarrativeContext {
  return {
    status: "ready",
    period: "week",
    metricDeltas: [],
    bandTransitions: [],
    drivers: [],
    coincidentFlags: [],
    pairsTested: 0,
    fdrQ: 0.1,
    provenance: {
      metrics: [],
      window: {
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-08T00:00:00.000Z",
      },
      computedAt: "2026-05-08T05:00:00.000Z",
    },
    ...over,
  };
}

const WEIGHT_DOWN = {
  type: "WEIGHT" as const,
  unit: "kg",
  current: 80,
  prior: 81,
  delta: -1,
  deltaPercent: -1.2,
  currentDays: 6,
  priorDays: 7,
};

describe("buildDeterministicNarrative", () => {
  it("leads with the ranked changes and labels the metric in English", () => {
    const text = buildDeterministicNarrative(
      ctx({ metricDeltas: [WEIGHT_DOWN] }),
      "en",
    );
    expect(text).toContain("the last week");
    expect(text).toContain("your weight");
    expect(text).toContain("1 kg");
    expect(text).toContain("1.2%"); // dot decimal mark in English
  });

  it("localises labels, decimal mark, and period in German", () => {
    const text = buildDeterministicNarrative(
      ctx({ metricDeltas: [WEIGHT_DOWN] }),
      "de",
    );
    expect(text).toContain("der letzten Woche");
    expect(text).toContain("dein Gewicht");
    expect(text).toContain("1,2 %"); // comma decimal mark
  });

  it("ranks by relative magnitude and caps at three movers", () => {
    const deltas = [
      { ...WEIGHT_DOWN, type: "WEIGHT" as const, delta: -1, deltaPercent: -1 },
      {
        ...WEIGHT_DOWN,
        type: "PULSE" as const,
        unit: "bpm",
        delta: 5,
        deltaPercent: 8,
      },
      {
        ...WEIGHT_DOWN,
        type: "RESTING_HEART_RATE" as const,
        unit: "bpm",
        delta: 2,
        deltaPercent: 3,
      },
      {
        ...WEIGHT_DOWN,
        type: "BODY_FAT" as const,
        unit: "%",
        delta: 0.1,
        deltaPercent: 0.3,
      },
    ];
    const text = buildDeterministicNarrative(
      ctx({ metricDeltas: deltas }),
      "en",
    );
    // Pulse (+8%) is the strongest mover and must lead; the 0.3% body-fat
    // mover is below the top three and must be dropped.
    expect(text.indexOf("your pulse")).toBeGreaterThan(-1);
    expect(text).not.toContain("body fat");
    expect(text.indexOf("your pulse")).toBeLessThan(
      text.indexOf("your weight"),
    );
  });

  it("reports a held-steady period when nothing moved", () => {
    expect(buildDeterministicNarrative(ctx(), "en")).toContain(
      "held largely steady",
    );
    expect(buildDeterministicNarrative(ctx(), "de")).toContain(
      "weitgehend stabil",
    );
  });

  it("notes vitals that moved outside the typical range", () => {
    const text = buildDeterministicNarrative(
      ctx({
        bandTransitions: [
          {
            type: "BLOOD_PRESSURE_SYS",
            unit: "mmHg",
            center: 140,
            bandLow: 110,
            bandHigh: 130,
            direction: "above",
            movedOut: true,
            baselineDays: 10,
          },
        ],
      }),
      "en",
    );
    expect(text).toContain("systolic blood pressure");
    expect(text).toContain("above your typical range");
  });

  it("mentions associations strictly non-causally and never invents one", () => {
    const withDrivers = buildDeterministicNarrative(
      ctx({
        drivers: [
          {
            behaviour: "ACTIVITY_STEPS",
            outcome: "SLEEP_DURATION",
            r: 0.4,
            qValue: 0.02,
            n: 14,
            interpretation: "x",
          },
        ],
      }),
      "en",
    );
    expect(withDrivers).toContain("not causal");
    expect(withDrivers).toContain("1 statistical association");
    // No drivers → no association sentence at all.
    expect(buildDeterministicNarrative(ctx(), "en")).not.toContain(
      "association",
    );
  });

  // v1.28.40 — the deterministic floor opens with a one-line verdict before the
  // delta list, matching the verdict-first AI narrative beside it.
  it("opens with a movement verdict before the delta list (en/de)", () => {
    const en = buildDeterministicNarrative(
      ctx({ metricDeltas: [WEIGHT_DOWN] }),
      "en",
    );
    expect(en.startsWith("A week of real movement.")).toBe(true);
    // The changes sentence + its figures still follow the verdict.
    expect(en).toContain("your weight");
    const de = buildDeterministicNarrative(
      ctx({ metricDeltas: [WEIGHT_DOWN] }),
      "de",
    );
    expect(de.startsWith("Eine Woche mit echter Bewegung.")).toBe(true);
  });

  it("opens with a calm verdict when nothing moved (en/de, month)", () => {
    expect(buildDeterministicNarrative(ctx({ period: "month" }), "en")).toMatch(
      /^A calm month\./,
    );
    expect(buildDeterministicNarrative(ctx({ period: "month" }), "de")).toMatch(
      /^Ein ruhiger Monat\./,
    );
  });

  it("rounds each change to its unit and keeps one bracket level (de/en)", () => {
    const deltas = [
      {
        ...WEIGHT_DOWN,
        type: "ACTIVITY_STEPS" as const,
        unit: "",
        current: 17_400,
        prior: 20_308.68,
        delta: -2908.68,
        deltaPercent: -14.3,
      },
      {
        ...WEIGHT_DOWN,
        type: "BLOOD_PRESSURE_DIA" as const,
        unit: "mmHg",
        current: 84.6,
        prior: 78.19,
        delta: 6.41,
        deltaPercent: 8.2,
      },
      {
        ...WEIGHT_DOWN,
        type: "WEIGHT" as const,
        unit: "kg",
        delta: -0.46,
        deltaPercent: -0.6,
      },
    ];
    const de = buildDeterministicNarrative(ctx({ metricDeltas: deltas }), "de");
    expect(de).toContain("deine Schritte (−2.909 Schritte, −14,3 %)");
    expect(de).toContain("dein diastolischer Blutdruck (+6 mmHg, +8,2 %)");
    expect(de).toContain("dein Gewicht (−0,5 kg, −0,6 %)");
    const en = buildDeterministicNarrative(ctx({ metricDeltas: deltas }), "en");
    expect(en).toContain("your step count (−2,909 steps, −14.3%)");
    expect(en).toContain("your diastolic blood pressure (+6 mmHg, +8.2%)");
    expect(en).toContain("your weight (−0.5 kg, −0.6%)");
    for (const text of [de, en]) {
      // No bracket opens inside another.
      expect(text).not.toMatch(/\([^)]*\(/);
      expect(text).not.toMatch(/\d[.,]\d{2}\b/);
    }
  });

  it("drops a change that rounds to nothing at its unit's grain", () => {
    const text = buildDeterministicNarrative(
      ctx({
        metricDeltas: [
          {
            ...WEIGHT_DOWN,
            type: "PULSE" as const,
            unit: "bpm",
            delta: 0.3,
            deltaPercent: 0.4,
          },
        ],
      }),
      "en",
    );
    expect(text).not.toContain("your pulse");
    expect(text).toContain("held largely steady");
  });

  it("falls back to a prettified label for an unmapped metric type", () => {
    const text = buildDeterministicNarrative(
      ctx({
        metricDeltas: [
          {
            ...WEIGHT_DOWN,
            // A type with no entry in METRIC_LABELS.
            type: "SOME_NEW_METRIC" as never,
            unit: "x",
            delta: 3,
            deltaPercent: 4,
          },
        ],
      }),
      "en",
    );
    expect(text).toContain("your some new metric");
  });
});
