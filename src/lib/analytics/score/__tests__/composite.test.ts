import { describe, expect, it } from "vitest";

import { buildOk, deriveCoverage } from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";
import {
  attachScoreDelta,
  computeComposite,
  SCORE_ALGORITHM_CHANGED_AT,
  type StoredScoreDay,
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
 * Since 1.50 `numberBand` is a function of the number, as for every other
 * HealthLog score, and the web draws it: an 81 that read "low" because one
 * pillar sat in the red said two things at once. The pillar in a worse band
 * is named beside the score as `bandSetter`. `band` keeps the worse of the
 * two for the apps that colour by it. The number, and so the delta, did not
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

/**
 * Two bands ride the composite. `band` keeps its 1.49 meaning, the worse of
 * the number's band and the worst counted pillar's, because every shipped
 * app colours the ring from it and explains it with "X set the colour of
 * this score". `numberBand` is the number's own band, the rule every other
 * HealthLog score follows; the web and newer apps draw it and name the
 * pillar beside it. They differ exactly when `bandSetter` is non-null.
 */
describe("the worst pillar holds band down, numberBand follows the number", () => {
  it("keeps band red and numberBand green when a counted pillar is red", () => {
    // Mean 73: green on the number, red on the wire's `band`.
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
    expect(result.value.band).toBe("red");
    expect(result.value.numberBand).toBe("green");
    expect(result.value.bandSetter).toBe("BLOOD_PRESSURE");
  });

  it("keeps band yellow under a yellow worst pillar, numberBand green", () => {
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
    expect(result.value.band).toBe("yellow");
    expect(result.value.numberBand).toBe("green");
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

  it("caps band at the worst pillar, bands numberBand on the number", () => {
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
      expect(result.value.band).toBe("red");
      expect(result.value.numberBand).toBe("green");
      expect(result.value.bandSetter).toBe("BLOOD_PRESSURE");
    }
  });
});

/**
 * 1.50 — the week-over-week move is read from the stored days, the same rows
 * the history chart draws, so the panel's "+2" is the difference between two
 * points of that chart. A move against a day the chart has no point for is
 * the contradiction this replaces.
 */
describe("the delta reads the score's own history", () => {
  const TODAY = "2026-08-20";
  const CORE: ScorePillarId[] = ["BLOOD_PRESSURE", "ACTIVITY", "SLEEP"];

  function day(offset: number): string {
    return new Date(Date.parse(`${TODAY}T12:00:00Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }

  function stored(
    offset: number,
    composite: number,
    options: {
      composition?: ScorePillarId[];
      scoreVersion?: number;
      configVersion?: number | null;
      computedAt?: Date;
    } = {},
  ): StoredScoreDay {
    return {
      dayKey: day(offset),
      composite,
      scoreVersion: options.scoreVersion ?? SCORE_VERSION,
      composition: options.composition ?? CORE,
      configVersion:
        options.configVersion === undefined ? 0 : options.configVersion,
      computedAt:
        options.computedAt ?? new Date(Date.parse(`${day(offset)}T09:00:00Z`)),
    };
  }

  function today(scores: number[], noiseFloor = 1) {
    return evaluation(
      CORE.map((id, i) => pillar(id, scores[i]!, { noiseFloor })),
      NOW,
    );
  }

  function delta(
    current: ReturnType<typeof today>,
    history: StoredScoreDay[],
    config = UNCONFIGURED_SCORE_BOUNDARY,
    asOf = NOW,
  ) {
    return attachScoreDelta({
      current,
      history,
      todayKey: TODAY,
      asOf,
      config,
    });
  }

  it("is the move between today's score and the stored day a week back", () => {
    const report = delta(today([75, 75, 72]), [
      stored(-7, 72),
      stored(-14, 70),
    ]);
    expect(report).toEqual({ delta: 2, deltaReason: null });
  });

  it("compares against the newest stored day of that week when the day itself is missing", () => {
    const report = delta(today([80, 80, 80]), [
      stored(-9, 70),
      stored(-13, 60),
      stored(-6, 90),
      stored(-16, 70),
    ]);
    // Day −6 sits inside the last week and is not the comparison day; −9 is
    // the newest of the week before it.
    expect(report).toEqual({ delta: 10, deltaReason: null });
  });

  it("says there is no previous window when the chart has no point there", () => {
    const report = delta(today([80, 80, 80]), [
      stored(-3, 70),
      stored(-20, 70),
    ]);
    expect(report).toEqual({
      delta: null,
      deltaReason: "no_previous_window",
    });
  });

  it("says there is no current score before anything else", () => {
    const none = evaluation([], NOW, CORE);
    expect(delta(none, [stored(-7, 70), stored(-14, 70)]).deltaReason).toBe(
      "no_current_score",
    );
  });

  it("suppresses delta across a composition change", () => {
    const report = delta(today([80, 80, 80]), [
      stored(-7, 75, { composition: [...CORE, "WELLBEING"] }),
      stored(-14, 75, { composition: [...CORE, "WELLBEING"] }),
    ]);
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("composition_changed");
  });

  it("suppresses the first comparable eligibility window", () => {
    const report = delta(today([80, 80, 80]), [
      stored(-7, 75),
      stored(-14, 70, { composition: ["BLOOD_PRESSURE", "ACTIVITY"] }),
    ]);
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("first_eligibility_window");
    expect(delta(today([80, 80, 80]), [stored(-7, 75)]).deltaReason).toBe(
      "first_eligibility_window",
    );
  });

  it("suppresses a day scored by another method", () => {
    const changedAt = new Date(SCORE_ALGORITHM_CHANGED_AT);
    const boundaryToday = changedAt.toISOString().slice(0, 10);
    const atBoundary = attachScoreDelta({
      current: today([80, 80, 80]),
      history: [
        {
          ...stored(-7, 75),
          dayKey: "2026-08-23",
          computedAt: new Date(changedAt.getTime() - 7 * 86_400_000),
        },
      ],
      todayKey: boundaryToday,
      asOf: changedAt,
      config: UNCONFIGURED_SCORE_BOUNDARY,
    });
    expect(atBoundary.deltaReason).toBe("algorithm_changed");

    const otherVersion = delta(today([80, 80, 80]), [
      stored(-7, 75, { scoreVersion: SCORE_VERSION - 1 }),
      stored(-14, 75, { scoreVersion: SCORE_VERSION - 1 }),
    ]);
    expect(otherVersion.deltaReason).toBe("algorithm_changed");
  });

  it("suppresses a day scored under another recipe of the person's own", () => {
    const config = { version: 3, changedAt: "2026-08-16T08:00:00.000Z" };
    const report = delta(
      today([80, 80, 80]),
      [
        stored(-7, 60, { configVersion: 2 }),
        stored(-14, 60, { configVersion: 2 }),
      ],
      config,
    );
    expect(report.deltaReason).toBe("config_changed");
    // A row written before the version was recorded answers by the date.
    const legacy = delta(
      today([80, 80, 80]),
      [
        stored(-7, 60, { configVersion: null }),
        stored(-14, 60, { configVersion: null }),
      ],
      config,
    );
    expect(legacy.deltaReason).toBe("config_changed");
  });

  it("suppresses movements below the combined noise floor", () => {
    const report = delta(today([81, 80, 80], 4), [
      stored(-7, 80),
      stored(-14, 80),
    ]);
    expect(report.delta).toBeNull();
    expect(report.deltaReason).toBe("below_noise_floor");
  });

  it("moves with the number the chart draws, slow pillars included", () => {
    // A new lipid panel moves the stored score the chart shows, so it moves
    // the delta too: the two can no longer say different things.
    const current = evaluation(
      [
        ...CORE.map((id) => pillar(id, 80)),
        pillar("LIPIDS", 20, { deltaEligible: false }),
      ],
      NOW,
    );
    const composition = [...CORE, "LIPIDS"] as ScorePillarId[];
    const report = delta(current, [
      stored(-7, 80, { composition }),
      stored(-14, 80, { composition }),
    ]);
    expect(report).toEqual({ delta: -15, deltaReason: null });
  });
});

/**
 * 1.50 — the weights published beside the number are the ones the number
 * was made with. The score is the plain mean of the counted pillars, so a
 * client that multiplies each pillar by its published weight must land on
 * the published score; a weight a scorer change left behind fails here.
 */
describe("the published pillar weights are the mean's own", () => {
  const SETS: number[][] = [
    [82, 64],
    [20, 100, 99],
    [71, 58, 90, 43, 66],
    [12.5, 87.25, 50, 61, 70, 33, 99],
  ];
  const IDS: ScorePillarId[] = [
    "BLOOD_PRESSURE",
    "ACTIVITY",
    "SLEEP",
    "ADIPOSITY",
    "WELLBEING",
    "GLYCAEMIA",
    "LIPIDS",
  ];

  for (const scores of SETS) {
    it(`weighs ${scores.length} counted pillars so they sum to the score`, () => {
      const entries = scores.map((score, index) => pillar(IDS[index], score));
      const result = evaluation(entries, NOW);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const weights = result.value.weights ?? [];
      expect(weights.map((w) => w.id)).toEqual(result.value.composition);
      expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 10);
      const weighted = weights.reduce((sum, w) => {
        const row = entries.find((entry) => entry.id === w.id)!;
        if (row.result.status !== "ok") throw new Error("uncounted pillar");
        return sum + w.weight * row.result.value.score;
      }, 0);
      expect(Math.round(weighted)).toBe(result.value.score);
    });
  }

  it("gives a pillar that did not count no weight", () => {
    const counted = pillar("ACTIVITY", 80);
    const gated: ScorePillarResult = {
      id: "SLEEP",
      domain: "sleep",
      result: {
        status: "insufficient",
        coverage: counted.result.coverage,
        provenance: counted.result.provenance,
        reason: "not_tracked",
      },
    };
    const result = evaluation([counted, gated], NOW);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.weights).toEqual([{ id: "ACTIVITY", weight: 1 }]);
  });
});
