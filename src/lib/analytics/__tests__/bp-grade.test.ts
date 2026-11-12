/**
 * v1.15.12 — unit pins for the graded BP pillar score.
 *
 * A profile averaging 134/87 against the under-65 ceiling of 129/79 is the
 * canonical regression: the binary all-time in-target rate read
 * ~10-16/100; the graded score must land in the borderline-stage-1 band
 * (low-to-mid 50s), not in the catastrophic band.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gradeBpScore,
  gradeBpScoreFromSeries,
  type BpPairPoint,
} from "../bp-grade";
import type { BpTargets } from "../bp-targets";

// Under-65 ESH band.
const UNDER65: BpTargets = {
  sysLow: 120,
  sysHigh: 129,
  diaLow: 70,
  diaHigh: 79,
};

/**
 * The score alone, for the arithmetic pins below. `gradeBpScore` returns
 * the score together with the basis that produced it; the basis has its
 * own describe block further down.
 */
function bpScore(input: { sys: number; dia: number; target: BpTargets }) {
  return gradeBpScore(input).score;
}

describe("gradeBpScore", () => {
  it("grades 134/87 into the borderline band [45,60]", () => {
    const score = bpScore({ sys: 134, dia: 87, target: UNDER65 });
    expect(score).toBeGreaterThanOrEqual(45);
    expect(score).toBeLessThanOrEqual(60);
  });

  it("grades a well-controlled 120/78 at or above 85", () => {
    expect(
      bpScore({ sys: 120, dia: 78, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(85);
  });

  it("grades a textbook-normal 118/76 very high (≈100)", () => {
    expect(
      bpScore({ sys: 118, dia: 76, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(88);
  });

  it("grades an uncontrolled 160/100 at or below 30", () => {
    expect(
      bpScore({ sys: 160, dia: 100, target: UNDER65 }),
    ).toBeLessThanOrEqual(30);
  });

  it("takes the WORSE axis — a single high diastolic drags the score down", () => {
    // sys perfect (118), dia far over (95): the worst axis should win.
    const sysOk = bpScore({ sys: 118, dia: 78, target: UNDER65 });
    const diaHigh = bpScore({ sys: 118, dia: 95, target: UNDER65 });
    expect(diaHigh).toBeLessThan(sysOk);
  });

  it("is monotonic — higher BP never scores better", () => {
    const a = bpScore({ sys: 130, dia: 82, target: UNDER65 });
    const b = bpScore({ sys: 140, dia: 88, target: UNDER65 });
    const c = bpScore({ sys: 150, dia: 95, target: UNDER65 });
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("has no cliff — a one-mmHg change moves the score by a small amount", () => {
    const at = bpScore({ sys: 129, dia: 79, target: UNDER65 });
    const justOver = bpScore({ sys: 130, dia: 79, target: UNDER65 });
    expect(at - justOver).toBeLessThanOrEqual(5);
    expect(at).toBeGreaterThanOrEqual(justOver);
  });

  it("penalises hypotension below the clinical floor (no longer reads ~100)", () => {
    // 85/45 is 5 mmHg below both floors (sys 90 / dia 50). The continuous
    // hypo curve gives a gentle penalty near the floor (5 below ≈ 85),
    // clearly below the optimal plateau of 100.
    const low = bpScore({ sys: 85, dia: 45, target: UNDER65 });
    expect(low).toBeLessThan(100);
    expect(low).toBeGreaterThanOrEqual(80);
    // A markedly low reading is penalised much harder.
    const veryLow = bpScore({ sys: 70, dia: 40, target: UNDER65 });
    expect(veryLow).toBeLessThan(low);
    expect(veryLow).toBeLessThanOrEqual(45);
  });

  it("has NO hypotension cliff — the floor boundary is continuous on both axes", () => {
    // Audit HIGH-1: above the floor the score sits on the optimal plateau
    // (100); the old below-floor branch jumped to ~81 at 1 mmHg under,
    // a 19-point cliff. The dedicated hypo curve starts at 100 AT the
    // floor and descends smoothly. Walk across the systolic floor (90):
    // dia 66 sits on the optimal plateau (offset −13 → 100) so the
    // systolic axis is the worst-of(sys,dia) winner across the walk.
    const sysWalk = [92, 91, 90, 89, 88].map((sys) =>
      bpScore({ sys, dia: 66, target: UNDER65 }),
    );
    // AT and ABOVE the floor sit on the plateau (100).
    expect(sysWalk[2]).toBe(100); // sys 90
    expect(sysWalk[1]).toBe(100); // sys 91
    expect(sysWalk[0]).toBe(100); // sys 92
    // Every per-step delta is small (no >5-point boundary jump) and the
    // score is monotonic non-increasing as BP drops below the floor.
    for (let i = 0; i < sysWalk.length - 1; i++) {
      const delta = sysWalk[i] - sysWalk[i + 1];
      expect(delta).toBeGreaterThanOrEqual(0); // non-increasing as BP drops
      expect(delta).toBeLessThanOrEqual(5); // no cliff
    }

    // Walk across the diastolic floor (50). Hold sys comfortably normal so
    // the diastolic axis is the worst-of(sys,dia) winner throughout.
    // sys 117 sits on the optimal plateau (offset −12 → 100) so the
    // diastolic axis is the worst-of(sys,dia) winner across the walk.
    const diaWalk = [52, 51, 50, 49, 48].map((dia) =>
      bpScore({ sys: 117, dia, target: UNDER65 }),
    );
    expect(diaWalk[2]).toBe(100); // dia 50
    expect(diaWalk[1]).toBe(100); // dia 51
    expect(diaWalk[0]).toBe(100); // dia 52
    for (let i = 0; i < diaWalk.length - 1; i++) {
      const delta = diaWalk[i] - diaWalk[i + 1];
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThanOrEqual(5);
    }
  });

  it("descends smoothly further below the floor (mirrors over-target steepness)", () => {
    // floor → 100, floor−10 → ~70, floor−20 → ~45, floor−30 → ~20.
    // dia 66 stays on the plateau so the systolic axis is the winner.
    expect(bpScore({ sys: 90, dia: 66, target: UNDER65 })).toBe(100);
    expect(bpScore({ sys: 80, dia: 66, target: UNDER65 })).toBe(70);
    expect(bpScore({ sys: 70, dia: 66, target: UNDER65 })).toBe(45);
    expect(bpScore({ sys: 60, dia: 66, target: UNDER65 })).toBe(20);
    // Never negative on an extreme low.
    expect(
      bpScore({ sys: 30, dia: 20, target: UNDER65 }),
    ).toBeGreaterThanOrEqual(0);
  });

  it("preserves the fairness anchors (134/87 → 57, 165/105 → 22)", () => {
    expect(bpScore({ sys: 134, dia: 87, target: UNDER65 })).toBe(57);
    expect(bpScore({ sys: 165, dia: 105, target: UNDER65 })).toBe(22);
  });
});

describe("gradeBpScoreFromSeries", () => {
  const NOW = new Date("2026-06-07T12:00:00.000Z");
  const daysAgo = (n: number): Date =>
    new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it("returns null for an empty series", () => {
    expect(
      gradeBpScoreFromSeries({ pairs: [], target: UNDER65, now: NOW }),
    ).toBeNull();
  });

  it("weights recent readings more — recent improvement lifts the score", () => {
    // Old readings high, recent readings well-controlled.
    const pairs: BpPairPoint[] = [
      { at: daysAgo(300), sys: 160, dia: 100 },
      { at: daysAgo(280), sys: 158, dia: 98 },
      { at: daysAgo(5), sys: 120, dia: 76 },
      { at: daysAgo(2), sys: 119, dia: 75 },
      { at: daysAgo(0), sys: 121, dia: 77 },
    ];
    const recencyWeighted = gradeBpScoreFromSeries({
      pairs,
      target: UNDER65,
      now: NOW,
    });
    // A flat (unweighted) mean would be dragged toward ~145/90; the
    // recency-weighted representative should read close to the recent
    // well-controlled cluster.
    expect(recencyWeighted).not.toBeNull();
    expect(recencyWeighted!.score).toBeGreaterThanOrEqual(80);
  });

  it("matches the single-reading grade when every pair is today", () => {
    const pairs: BpPairPoint[] = [
      { at: NOW, sys: 134, dia: 87 },
      { at: NOW, sys: 134, dia: 87 },
    ];
    expect(
      gradeBpScoreFromSeries({ pairs, target: UNDER65, now: NOW }),
    ).toEqual(gradeBpScore({ sys: 134, dia: 87, target: UNDER65 }));
  });

  it("rollup (per-day-mean + count) and live (per-event) agree on the same data", () => {
    // Audit HIGH-2 regression guard. A multi-reading high day today
    // (4× 150/95) plus a calm day yesterday (1× 115/72). The live path
    // grades the 5 per-event pairs; the rollup path grades the two per-day
    // MEAN pairs but weights today's mean by its count (4). Both must
    // produce the same graded score, otherwise the BP pillar diverges by
    // up to ~20 points depending on DAY-bucket warmth.
    const today = daysAgo(0);
    const yesterday = daysAgo(1);

    // Live: one pair per event (count defaults to 1).
    const livePairs: BpPairPoint[] = [
      { at: today, sys: 150, dia: 95 },
      { at: today, sys: 150, dia: 95 },
      { at: today, sys: 150, dia: 95 },
      { at: today, sys: 150, dia: 95 },
      { at: yesterday, sys: 115, dia: 72 },
    ];
    // Rollup: one per-day-MEAN pair, weighted by perDayPairCount.
    const rollupPairs: BpPairPoint[] = [
      { at: today, sys: 150, dia: 95, count: 4 },
      { at: yesterday, sys: 115, dia: 72, count: 1 },
    ];

    const live = gradeBpScoreFromSeries({
      pairs: livePairs,
      target: UNDER65,
      now: NOW,
    });
    const rollup = gradeBpScoreFromSeries({
      pairs: rollupPairs,
      target: UNDER65,
      now: NOW,
    });
    expect(live).not.toBeNull();
    expect(rollup).not.toBeNull();
    expect(Math.abs(live!.score - rollup!.score)).toBeLessThanOrEqual(1);
  });
});

/**
 * v1.34.5 — the basis published with the score. The pillar scores the
 * WORSE of the two axes; these pin which axis that was, what it was
 * measured against, and that the three relations the popover can render
 * are the only three that exist.
 */
describe("gradeBpScore — the basis", () => {
  // Hypotension floors, mirrored from `bp-in-target` so the sweep below
  // can reconstruct the boundary the grader must have used.
  const SYS_FLOOR = 90;
  const DIA_FLOOR = 50;

  it("names the systolic axis when it is the worse one", () => {
    // 137/84: sys 8 over its ceiling, dia 5 over its own — systolic worse.
    const { score, basis } = gradeBpScore({
      sys: 137,
      dia: 84,
      target: UNDER65,
    });
    expect(basis).toEqual({
      axis: "systolic",
      relation: "above_ceiling",
      offsetMmHg: 8,
      boundaryMmHg: 129,
    });
    expect(score).toBe(57);
  });

  it("names the diastolic axis when it is the worse one", () => {
    // 132/88: sys 3 over, dia 9 over — diastolic worse, and the basis
    // must say so rather than defaulting to the axis people read first.
    const { score, basis } = gradeBpScore({
      sys: 132,
      dia: 88,
      target: UNDER65,
    });
    expect(basis).toEqual({
      axis: "diastolic",
      relation: "above_ceiling",
      offsetMmHg: 9,
      boundaryMmHg: 79,
    });
    expect(score).toBe(55);
  });

  it("breaks a tie toward systolic", () => {
    // Both axes sit exactly 5 mmHg over their own ceiling, so both grade
    // 65 and the score cannot say which one it came from. The documented
    // rule picks systolic.
    const { basis } = gradeBpScore({ sys: 134, dia: 84, target: UNDER65 });
    expect(basis.axis).toBe("systolic");
    expect(basis.boundaryMmHg).toBe(129);
    // …and at the ceiling itself, where both axes grade 85.
    expect(gradeBpScore({ sys: 129, dia: 79, target: UNDER65 }).basis).toEqual({
      axis: "systolic",
      relation: "in_band",
      offsetMmHg: 0,
      boundaryMmHg: 129,
    });
  });

  it("reports a reading inside the band as in_band, measured from the ceiling", () => {
    const { score, basis } = gradeBpScore({
      sys: 124,
      dia: 74,
      target: UNDER65,
    });
    expect(basis.relation).toBe("in_band");
    expect(basis.boundaryMmHg).toBe(129);
    expect(basis.offsetMmHg).toBe(5); // five below the ceiling
    expect(score).toBeGreaterThanOrEqual(85);
  });

  it("reports a hypotensive reading as below_floor, measured from the floor", () => {
    // 86/70: systolic 4 under the 90 floor; diastolic comfortably in band.
    const { basis } = gradeBpScore({ sys: 86, dia: 70, target: UNDER65 });
    expect(basis).toEqual({
      axis: "systolic",
      relation: "below_floor",
      offsetMmHg: 4,
      boundaryMmHg: SYS_FLOOR,
    });
  });

  it("keeps below_floor even when the score is still high — the curve is gentle near the floor", () => {
    // Worth pinning because it is easy to assume "below the floor" implies
    // a poor score: two mmHg under reads 94, comfortably green. The
    // relation is decided by where the value sits, never by the score.
    const { score, basis } = gradeBpScore({
      sys: 88,
      dia: 70,
      target: UNDER65,
    });
    expect(basis.relation).toBe("below_floor");
    expect(score).toBeGreaterThanOrEqual(85);
  });

  it("keeps the relation with the score when the rounded offset reads zero", () => {
    // 129.4 is above the ceiling and scores below 85, but rounds to a
    // 0 mmHg offset. The relation follows the unrounded value, so the
    // sentence can never claim "in band" about a sub-85 number.
    const { score, basis } = gradeBpScore({
      sys: 129.4,
      dia: 70,
      target: UNDER65,
    });
    expect(basis.relation).toBe("above_ceiling");
    expect(basis.offsetMmHg).toBe(0);
    expect(score).toBeLessThan(85);
  });

  it("reproduces the worked 137.5/87 example — systolic, ~9 over, 56", () => {
    const { score, basis } = gradeBpScore({
      sys: 137.5,
      dia: 87,
      target: UNDER65,
    });
    expect(score).toBe(56);
    expect(basis).toEqual({
      axis: "systolic",
      relation: "above_ceiling",
      offsetMmHg: 9,
      boundaryMmHg: 129,
    });
  });

  it("uses the targets it was handed, not a fixed band", () => {
    const over65: BpTargets = {
      sysLow: 130,
      sysHigh: 139,
      diaLow: 70,
      diaHigh: 79,
    };
    const { basis } = gradeBpScore({ sys: 137, dia: 70, target: over65 });
    expect(basis).toEqual({
      axis: "systolic",
      relation: "in_band",
      offsetMmHg: 2,
      boundaryMmHg: 139,
    });
  });

  it("has exactly three relations, and each one reconstructs its own reading", () => {
    // The design asserts the three relations are exhaustive; this pins it
    // against the anchors instead of trusting the prose. Every integer
    // reading across the whole plausible range must land in exactly one
    // relation, and axis + relation + boundary + offset together must
    // reconstruct the value that produced the score.
    const seen = new Set<string>();
    for (let sys = 60; sys <= 220; sys += 1) {
      for (let dia = 30; dia <= 140; dia += 1) {
        const { score, basis } = gradeBpScore({ sys, dia, target: UNDER65 });
        seen.add(basis.relation);
        const value = basis.axis === "systolic" ? sys : dia;
        const floor = basis.axis === "systolic" ? SYS_FLOOR : DIA_FLOOR;
        const ceiling =
          basis.axis === "systolic" ? UNDER65.sysHigh : UNDER65.diaHigh;

        if (basis.relation === "below_floor") {
          expect(value).toBeLessThan(floor);
          expect(basis.boundaryMmHg).toBe(floor);
          expect(floor - value).toBe(basis.offsetMmHg);
        } else {
          expect(value).toBeGreaterThanOrEqual(floor);
          expect(basis.boundaryMmHg).toBe(ceiling);
          expect(Math.abs(value - ceiling)).toBe(basis.offsetMmHg);
          if (basis.relation === "in_band") {
            expect(value).toBeLessThanOrEqual(ceiling);
            // The scale line only makes sense if in_band never reads red.
            expect(score).toBeGreaterThanOrEqual(85);
          } else {
            expect(basis.relation).toBe("above_ceiling");
            expect(value).toBeGreaterThan(ceiling);
            expect(score).toBeLessThan(85);
          }
        }

        // The named axis alone carries the score: replace the other axis
        // with an optimal value and the number must not move.
        const optimalOther = gradeBpScore(
          basis.axis === "systolic"
            ? { sys, dia: UNDER65.diaHigh - 12, target: UNDER65 }
            : { sys: UNDER65.sysHigh - 12, dia, target: UNDER65 },
        );
        expect(optimalOther.score).toBe(score);
      }
    }
    expect([...seen].sort()).toEqual([
      "above_ceiling",
      "below_floor",
      "in_band",
    ]);
  });
});

describe("gradeBpScoreFromSeries — the basis travels with the score", () => {
  const NOW = new Date("2026-06-07T12:00:00.000Z");

  it("returns the basis of the representative it graded, not of any single pair", () => {
    // Two readings, one at each end. The representative is their mean
    // (both same-day, so equal weight): 130/85. The basis must describe
    // that mean, which matches neither reading.
    const graded = gradeBpScoreFromSeries({
      pairs: [
        { at: NOW, sys: 120, dia: 80 },
        { at: NOW, sys: 140, dia: 90 },
      ],
      target: UNDER65,
      now: NOW,
    });
    expect(graded).not.toBeNull();
    expect(graded!.basis).toEqual({
      axis: "diastolic",
      relation: "above_ceiling",
      offsetMmHg: 6,
      boundaryMmHg: 79,
    });
    expect(graded!.score).toBe(
      gradeBpScore({ sys: 130, dia: 85, target: UNDER65 }).score,
    );
  });

  it("grades the basis against the targets it was given", () => {
    // The analytics route re-runs this helper with the CLINICAL targets
    // when the user keeps a personal one. Same series, two bands: both
    // the score and the basis must move together.
    const pairs: BpPairPoint[] = [{ at: NOW, sys: 132, dia: 88 }];
    const clinical = gradeBpScoreFromSeries({
      pairs,
      target: UNDER65,
      now: NOW,
    })!;
    const personal = gradeBpScoreFromSeries({
      pairs,
      target: { sysLow: 120, sysHigh: 135, diaLow: 70, diaHigh: 90 },
      now: NOW,
    })!;
    expect(clinical.basis.boundaryMmHg).toBe(79);
    expect(clinical.basis.relation).toBe("above_ceiling");
    expect(personal.basis.relation).toBe("in_band");
    expect(personal.score).toBeGreaterThan(clinical.score);
  });
});

/**
 * The popover's scale line quotes two numbers out of this curve ("at the
 * ceiling the score is 85; 100 means roughly 12 mmHg below it") because
 * the sentence has to read naturally in six languages. That makes the
 * copy and the anchors two places that must agree, so this pins them to
 * each other: re-anchoring the curve turns this red and the six strings
 * have to follow.
 */
describe("the scale the popover quotes", () => {
  const AT_CEILING_SCORE = 85;
  const OPTIMAL_OFFSET_MMHG = 12;

  it("still scores 85 at the ceiling and 100 at twelve below it", () => {
    expect(
      bpScore({ sys: UNDER65.sysHigh, dia: UNDER65.diaHigh, target: UNDER65 }),
    ).toBe(AT_CEILING_SCORE);
    expect(
      bpScore({
        sys: UNDER65.sysHigh - OPTIMAL_OFFSET_MMHG,
        dia: UNDER65.diaHigh - OPTIMAL_OFFSET_MMHG,
        target: UNDER65,
      }),
    ).toBe(100);
    // Twelve is the SMALLEST distance that reaches 100 — one less does not.
    expect(
      bpScore({
        sys: UNDER65.sysHigh - (OPTIMAL_OFFSET_MMHG - 1),
        dia: UNDER65.diaHigh - (OPTIMAL_OFFSET_MMHG - 1),
        target: UNDER65,
      }),
    ).toBeLessThan(100);
  });

  it.each(["en", "de", "fr", "es", "it", "pl", "ko", "nl", "pt-BR"])(
    "quotes those same two numbers in %s",
    (locale) => {
      const bundle = JSON.parse(
        readFileSync(
          join(__dirname, "../../../../messages", `${locale}.json`),
          "utf8",
        ),
      ) as { insights: { healthScore: Record<string, string> } };
      const line = bundle.insights.healthScore.bpScale;
      expect(line).toContain(String(AT_CEILING_SCORE));
      expect(line).toContain(String(OPTIMAL_OFFSET_MMHG));
      expect(line).toContain("100");
    },
  );
});
