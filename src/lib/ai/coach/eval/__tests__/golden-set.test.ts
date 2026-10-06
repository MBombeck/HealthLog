/**
 * Coach golden-set gate (B0, v1.21.3) — the per-PR deterministic floor.
 *
 * Grades every golden case's reference response through the deterministic
 * graders. A reference response is authored to clear every `mustInclude` and
 * trip no `mustAvoid`; this suite proves the graders + criteria are
 * self-consistent and that the floor holds. A future Coach change that, say,
 * weakens the own-baseline matcher or the grounding verifier reddens this gate.
 *
 * No model call, no network — this is the free gate that runs on every change.
 */
import { describe, expect, it } from "vitest";

import {
  GOLDEN_CASES,
  taxonomyCoverage,
  type CoachEvalTaxonomy,
} from "@/lib/ai/coach/eval/golden-cases";
import { captureDeterministic } from "@/lib/ai/coach/eval/run-case";
import { gradeCase, gradeSet } from "@/lib/ai/coach/eval/grade-groundedness";

describe("Coach golden set — deterministic floor", () => {
  it("has a meaningful case count across the taxonomy", () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(30);
    const coverage = taxonomyCoverage();
    const buckets: CoachEvalTaxonomy[] = [
      "grounding",
      "crossMetric",
      "dataHonesty",
      "providerParity",
      "ownBaseline",
      "voice",
    ];
    for (const bucket of buckets) {
      expect(coverage[bucket], `taxonomy ${bucket}`).toBeGreaterThan(0);
    }
  });

  it("every case has a unique id", () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(GOLDEN_CASES.map((c) => [c.id, c] as const))(
    "ideal response clears every criterion: %s",
    (_id, testCase) => {
      const capture = captureDeterministic(testCase);
      const grade = gradeCase(testCase, capture);
      const failing = grade.criteria.filter((c) => !c.passed);
      expect(
        failing,
        `failing criteria: ${failing.map((c) => c.label).join("; ")}`,
      ).toEqual([]);
      expect(grade.passed).toBe(true);
    },
  );

  it("the whole set passes deterministically", () => {
    const captures = GOLDEN_CASES.map(captureDeterministic);
    const result = gradeSet(GOLDEN_CASES, captures);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(GOLDEN_CASES.length);
  });
});

describe("grader catches regressions (negative controls)", () => {
  it("flags an off-snapshot number on a grounding case", () => {
    const groundingCase = GOLDEN_CASES.find(
      (c) => c.id === "grounding-bp-mean",
    )!;
    const capture = {
      id: groundingCase.id,
      prose: "Your systolic averaged about 199 this month.",
      toolPayloads: [groundingCase.snapshotSections],
    };
    const grade = gradeCase(groundingCase, capture);
    expect(grade.passed).toBe(false);
  });

  it("flags a confident verdict on a sparse-data case", () => {
    const sparseCase = GOLDEN_CASES.find((c) => c.id === "honesty-sparse-bp")!;
    const capture = {
      id: sparseCase.id,
      prose: "You are clearly hypertensive and need to act now.",
      toolPayloads: [sparseCase.snapshotSections],
    };
    const grade = gradeCase(sparseCase, capture);
    expect(grade.passed).toBe(false);
  });

  it("flags a population-norm answer on an own-baseline case", () => {
    const baselineCase = GOLDEN_CASES.find(
      (c) => c.id === "baseline-bp-own-range",
    )!;
    const capture = {
      id: baselineCase.id,
      prose:
        "The normal range is under 120, and most healthy adults sit below that.",
      toolPayloads: [baselineCase.snapshotSections],
    };
    const grade = gradeCase(baselineCase, capture);
    expect(grade.passed).toBe(false);
  });

  it("flags two tiles read side by side on a cross-metric case", () => {
    const crossCase = GOLDEN_CASES.find(
      (c) => c.id === "cross-recovery-driver",
    )!;
    const capture = {
      id: crossCase.id,
      // Reads recovery and sleep as two facts, never names the driver/link.
      prose: "Your recovery is 41. Your sleep averaged 5.2 hours.",
      toolPayloads: [crossCase.snapshotSections],
    };
    const grade = gradeCase(crossCase, capture);
    expect(grade.passed).toBe(false);
  });
});
