import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";
import {
  attachScoreDelta,
  computeComposite,
  SCORE_ALGORITHM_CHANGED_AT,
} from "../composite";
import { UNCONFIGURED_SCORE_BOUNDARY } from "../config";
import { SCORE_GREEN_FLOOR, scoreBand } from "../shared";
import {
  SCORE_VERSION,
  type PillarValue,
  type ScorePillarId,
  type ScorePillarResult,
} from "../types";

const NOW = new Date("2026-08-20T12:00:00.000Z");

const DOMAIN_BY_PILLAR: Record<ScorePillarId, ScorePillarResult["domain"]> = {
  BLOOD_PRESSURE: "cardiometabolic",
  GLYCAEMIA: "cardiometabolic",
  ACTIVITY: "activity",
  SLEEP: "sleep",
  ADIPOSITY: "adiposity",
  WELLBEING: "wellbeing",
  LIPIDS: "cardiometabolic",
};

function pillar(
  id: ScorePillarId,
  score: number,
  options: {
    deltaEligible?: boolean;
    noiseFloor?: number;
    historyDays?: number;
    deltaIdentity?: string;
  } = {},
): ScorePillarResult {
  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: options.historyDays ?? 28,
    missing: [],
    fullHistoryDays: 28,
  });
  const value: PillarValue = {
    score,
    observed: {
      label: `${score}`,
      value: score,
      unit: "score",
      asOf: NOW.toISOString(),
      sources: ["MANUAL"],
    },
    reference: {
      kind: "guideline-band",
      low: 0,
      high: 100,
      label: "test reference",
      source: "Test 2026",
    },
    noiseFloor: options.noiseFloor ?? 1,
    deltaEligible: options.deltaEligible ?? true,
    deltaIdentity: options.deltaIdentity ?? id,
  };
  const result: Derived<PillarValue> = buildOk({
    value,
    coverage,
    confidence,
    provenance: {
      inputs: [id],
      source: "live",
      windowDays: 28,
      computedAt: NOW.toISOString(),
    },
  });
  return { id, domain: DOMAIN_BY_PILLAR[id], result };
}

function evaluation(
  entries: ScorePillarResult[],
  asOf: Date,
  available = entries.map((entry) => entry.id),
) {
  return computeComposite({
    pillars: entries,
    availablePillars: available,
    asOf,
    configured: false,
  });
}

/**
 * Where the band changes, and what the band is NOT.
 *
 * v1.35.1 moved green from 75 to 70, so the Health Score says the same
 * thing by a green dot that Readiness and the sleep score already did.
 * Boundaries are pinned on both sides because an off-by-one here is
 * invisible: a `>` where a `>=` belongs looks perfectly healthy at 80.
 *
 * Since 1.50 the band IS a function of the number, as for every other
 * HealthLog score: an 81 that read "low" because one pillar sat in the red
 * said two things at once. The pillar in a worse band is named beside the
 * score as `bandSetter` instead. The number, and so the delta, did not
 * move, which is why `SCORE_VERSION` did not either; stored days keep the
 * band they were shown under.
 */
describe("the band the mean alone gives", () => {
  const CASES: Array<[number, string]> = [
    [69, "yellow"],
    [70, "green"],
    [74, "green"],
    [75, "green"],
    [49, "red"],
    [50, "yellow"],
  ];

  for (const [score, expected] of CASES) {
    it(`calls ${score} ${expected}`, () => {
      expect(scoreBand(score)).toBe(expected);
    });
  }

  it("says the same thing the app's other two scores say", () => {
    // Readiness and the sleep score both call 70 green. Three scores in
    // one app cannot mean three things by one colour, and the Health
    // Score was the outlier.
    expect(scoreBand(SCORE_GREEN_FLOOR)).toBe("green");
    expect(scoreBand(SCORE_GREEN_FLOOR - 1)).toBe("yellow");
    expect(SCORE_GREEN_FLOOR).toBe(70);
  });

  it("moved the method version with it", () => {
    // A stored day keeps the band it was shown under, and the notice key
    // carries this number, so each account hears once that the rules
    // moved. A threshold edit without a version bump is a silent one, and
    // so is an eligibility edit: v1.38 widened who gets a score at all,
    // which is why this floor moved from 2 to 3.
    expect(SCORE_VERSION).toBeGreaterThan(3);
  });
});

describe("the worst pillar is named, not folded into the band", () => {
  it("keeps a composite green on its number when a counted pillar is red", () => {
    // Mean 73: green on the number. The red pillar is named, not hidden,
    // and does not turn the score's own band red.
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 20),
        pillar("ACTIVITY", 100),
        pillar("SLEEP", 100),
      ],
      NOW,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.score).toBe(73);
    expect(scoreBand(result.value.score)).toBe("green");
    expect(result.value.band).toBe("green");
    expect(result.value.bandSetter).toBe("BLOOD_PRESSURE");
  });

  it("names a yellow worst pillar under a green score", () => {
    // Mean 84, every pillar above the red floor, one of them yellow.
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 52),
        pillar("ACTIVITY", 100),
        pillar("SLEEP", 100),
      ],
      NOW,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(scoreBand(result.value.score)).toBe("green");
    expect(result.value.band).toBe("green");
    expect(result.value.bandSetter).toBe("BLOOD_PRESSURE");
  });

  it("names no setter when every pillar clears the mean's band", () => {
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 71),
        pillar("ACTIVITY", 90),
        pillar("SLEEP", 90),
      ],
      NOW,
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.band).toBe("green");
    expect(result.value.bandSetter).toBeNull();
  });
});

describe("reference-score composite", () => {
  it("scores two areas of health, and says it was two", () => {
    // Inverted from the v1.35 pin, which asserted this exact pair came
    // back `insufficient`. Three areas is the recommendation now, so a
    // person with two gets their number and a basis block that does not
    // overstate it. Note `physiological: false` — neither activity nor
    // wellbeing is a measurement, and the old rule refused the set on
    // that ground alone.
    const partial = evaluation(
      [pillar("ACTIVITY", 90), pillar("WELLBEING", 80)],
      NOW,
    );
    expect(partial.status).toBe("ok");
    if (partial.status !== "ok") return;
    expect(partial.value.score).toBe(85);
    expect(partial.value.scoreBasis).toEqual({
      domains: 2,
      recommended: 3,
      tier: "partial",
      physiological: false,
    });

    const full = evaluation(
      [pillar("ACTIVITY", 90), pillar("WELLBEING", 80), pillar("SLEEP", 70)],
      NOW,
    );
    expect(full.status).toBe("ok");
    if (full.status !== "ok") return;
    expect(full.value.scoreBasis?.tier).toBe("full");
    expect(full.value.scoreBasis?.physiological).toBe(true);
  });

  it("reports breadth coverage as distinct eligible domains", () => {
    // Same fixture as the v1.35 version — four pillars, two areas — and
    // the same coverage arithmetic. What changed is the outcome. The
    // fraction used to be a floor every scored account had already
    // cleared; it is a real moving number on a scored account now, which
    // is what makes the coverage meter say something.
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("GLYCAEMIA", 85),
        pillar("LIPIDS", 80),
        pillar("ACTIVITY", 75),
      ],
      NOW,
    );

    expect(result.status).toBe("ok");
    expect(result.coverage.requiredInputs).toBe(3);
    expect(result.coverage.presentInputs).toBe(2);
    if (result.status !== "ok") return;
    expect(result.value.scoreBasis).toEqual({
      domains: 2,
      recommended: 3,
      tier: "partial",
      physiological: true,
    });
    // The narrower set does not read as fully confident, and nothing new
    // was built for that: the existing coverage blend already does it.
    expect(result.confidence.score).toBeLessThan(100);
  });

  it("scores one area of health, at the tier that says so", () => {
    // The bottom tier boundary, on the shape most likely to fool a
    // client that counts `composition` instead of areas: three pillars,
    // one area.
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("GLYCAEMIA", 84),
        pillar("LIPIDS", 81),
      ],
      NOW,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.score).toBe(85);
    expect(result.value.composition).toHaveLength(3);
    expect(result.value.scoreBasis).toEqual({
      domains: 1,
      recommended: 3,
      tier: "minimal",
      physiological: true,
    });
  });

  it("refuses when not one pillar is usable, and says why", () => {
    // The counter-case. Grading instead of gating is only honest while
    // something is still turned away; this is the something.
    const result = evaluation([], NOW);
    expect(result.status).toBe("insufficient");
    if (result.status !== "insufficient") return;
    expect(result.reason).toBe("no_usable_data");
  });

  it("uses equal weights in registry order", () => {
    const result = evaluation(
      [
        pillar("SLEEP", 90),
        pillar("BLOOD_PRESSURE", 60),
        pillar("ACTIVITY", 75),
      ],
      NOW,
      ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"],
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBe(75);
      expect(result.value.composition).toEqual([
        "BLOOD_PRESSURE",
        "ACTIVITY",
        "SLEEP",
      ]);
    }
  });

  it("bands the composite on its number and names the worse pillar", () => {
    const result = evaluation(
      [
        pillar("BLOOD_PRESSURE", 45),
        pillar("ACTIVITY", 100),
        pillar("SLEEP", 100),
      ],
      NOW,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.score).toBe(82);
      expect(result.value.band).toBe("green");
      expect(result.value.bandSetter).toBe("BLOOD_PRESSURE");
    }
  });

  it("suppresses delta across a composition change", () => {
    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("WELLBEING", 80),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 75),
        pillar("ACTIVITY", 75),
        pillar("SLEEP", 75),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const report = attachScoreDelta(
      current,
      previous,
      previous,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("composition_changed");
  });

  it("suppresses the first comparable eligibility window", () => {
    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 75),
        pillar("ACTIVITY", 75),
        pillar("SLEEP", 75),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const previousPrevious = evaluation(
      [pillar("BLOOD_PRESSURE", 70), pillar("ACTIVITY", 70)],
      new Date(NOW.getTime() - 14 * 86_400_000),
    );
    const report = attachScoreDelta(
      current,
      previous,
      previousPrevious,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("first_eligibility_window");
  });

  it("suppresses the algorithm boundary and movements below the combined noise floor", () => {
    const changedAt = new Date(SCORE_ALGORITHM_CHANGED_AT);
    const currentAtBoundary = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
      ],
      changedAt,
    );
    const beforeBoundary = evaluation(
      [
        pillar("BLOOD_PRESSURE", 75),
        pillar("ACTIVITY", 75),
        pillar("SLEEP", 75),
      ],
      new Date(changedAt.getTime() - 7 * 86_400_000),
    );
    const algorithm = attachScoreDelta(
      currentAtBoundary,
      beforeBoundary,
      beforeBoundary,
      changedAt,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(algorithm.deltaReason).toBe("algorithm_changed");

    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 81, { noiseFloor: 4 }),
        pillar("ACTIVITY", 80, { noiseFloor: 4 }),
        pillar("SLEEP", 80, { noiseFloor: 4 }),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80, { noiseFloor: 4 }),
        pillar("ACTIVITY", 80, { noiseFloor: 4 }),
        pillar("SLEEP", 80, { noiseFloor: 4 }),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const stablePrior = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80, { noiseFloor: 4 }),
        pillar("ACTIVITY", 80, { noiseFloor: 4 }),
        pillar("SLEEP", 80, { noiseFloor: 4 }),
      ],
      new Date(NOW.getTime() - 14 * 86_400_000),
    );
    const belowNoise = attachScoreDelta(
      current,
      previous,
      stablePrior,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
    );
    expect(belowNoise.delta).toBeNull();
    expect(belowNoise.deltaReason).toBe("below_noise_floor");
  });

  it("excludes slow pillars from the weekly delta", () => {
    const current = evaluation(
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("ACTIVITY", 90),
        pillar("SLEEP", 90),
        pillar("LIPIDS", 20, { deltaEligible: false }),
      ],
      NOW,
    );
    const previous = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("LIPIDS", 100, { deltaEligible: false }),
      ],
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const stablePrior = evaluation(
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("LIPIDS", 100, { deltaEligible: false }),
      ],
      new Date(NOW.getTime() - 14 * 86_400_000),
    );
    const report = attachScoreDelta(
      current,
      previous,
      stablePrior,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
      [
        pillar("BLOOD_PRESSURE", 90),
        pillar("ACTIVITY", 90),
        pillar("SLEEP", 90),
        pillar("LIPIDS", 20, { deltaEligible: false }),
      ],
      [
        pillar("BLOOD_PRESSURE", 80),
        pillar("ACTIVITY", 80),
        pillar("SLEEP", 80),
        pillar("LIPIDS", 100, { deltaEligible: false }),
      ],
    );
    expect(report.delta).toBe(10);
    expect(report.deltaReason).toBeNull();
  });

  it("excludes a pillar whose input mode changed from the delta intersection", () => {
    const currentPillars = [
      pillar("BLOOD_PRESSURE", 80),
      pillar("GLYCAEMIA", 100, { deltaIdentity: "hba1c" }),
      pillar("ACTIVITY", 80),
      pillar("SLEEP", 80),
    ];
    const previousPillars = [
      pillar("BLOOD_PRESSURE", 80),
      pillar("GLYCAEMIA", 20, { deltaIdentity: "fasting_glucose" }),
      pillar("ACTIVITY", 80),
      pillar("SLEEP", 80),
    ];
    const current = evaluation(currentPillars, NOW);
    const previous = evaluation(
      previousPillars,
      new Date(NOW.getTime() - 7 * 86_400_000),
    );
    const stablePrior = evaluation(
      previousPillars,
      new Date(NOW.getTime() - 14 * 86_400_000),
    );

    const report = attachScoreDelta(
      current,
      previous,
      stablePrior,
      NOW,
      UNCONFIGURED_SCORE_BOUNDARY,
      currentPillars,
      previousPillars,
    );

    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("below_noise_floor");
  });
});
