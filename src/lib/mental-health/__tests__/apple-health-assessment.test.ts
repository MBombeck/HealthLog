import { describe, expect, it } from "vitest";

import {
  checkAppleHealthAssessment,
  scoredAssessmentInstrument,
  type AppleHealthAssessmentEntry,
} from "../apple-health-assessment";

const base: AppleHealthAssessmentEntry = {
  index: 0,
  instrument: "PHQ9",
  value: 5,
  startDate: "2026-10-01T09:00:00.000Z",
  externalId: "0D7E1F5A-0000-4000-8000-000000000001",
};

describe("scoredAssessmentInstrument", () => {
  it("names the instrument of the two HealthKit scored assessments only", () => {
    expect(
      scoredAssessmentInstrument("HKScoredAssessmentTypeIdentifierPHQ9"),
    ).toBe("PHQ9");
    expect(
      scoredAssessmentInstrument("HKScoredAssessmentTypeIdentifierGAD7"),
    ).toBe("GAD7");
    expect(
      scoredAssessmentInstrument("HKQuantityTypeIdentifierBodyMass"),
    ).toBeNull();
    expect(scoredAssessmentInstrument("toString")).toBeNull();
  });
});

describe("checkAppleHealthAssessment", () => {
  it("admits a score without answers as score only", () => {
    const verdict = checkAppleHealthAssessment(base);
    expect(verdict).toEqual({
      ok: true,
      total: 5,
      answers: null,
      takenAt: new Date(base.startDate),
    });
  });

  it("admits answers that add up to the score", () => {
    const answers = [1, 1, 0, 0, 1, 0, 1, 0, 1];
    const verdict = checkAppleHealthAssessment({ ...base, answers });
    expect(verdict.ok && verdict.answers).toEqual(answers);
  });

  it("refuses answers whose total disagrees with the score", () => {
    const verdict = checkAppleHealthAssessment({
      ...base,
      answers: [3, 3, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(verdict).toEqual({
      ok: false,
      result: {
        index: 0,
        status: "skipped",
        reason: "invalid_assessment_answers",
      },
    });
  });

  it("refuses the wrong number of answers and an answer above the item ceiling", () => {
    for (const answers of [
      [1, 1, 1, 1, 1],
      [4, 1, 0, 0, 0, 0, 0, 0, 0],
      [0.5, 0.5, 1, 1, 1, 1, 0, 0, 0],
    ]) {
      const verdict = checkAppleHealthAssessment({ ...base, answers });
      expect(verdict.ok, JSON.stringify(answers)).toBe(false);
    }
  });

  it("refuses a score outside the instrument's range with the band applied", () => {
    for (const [instrument, value, max] of [
      ["PHQ9", 28, 27],
      ["GAD7", 22, 21],
      ["GAD7", -1, 21],
      ["PHQ9", 4.5, 27],
    ] as const) {
      const verdict = checkAppleHealthAssessment({
        ...base,
        instrument,
        value,
      });
      expect(verdict).toEqual({
        ok: false,
        result: {
          index: 0,
          status: "skipped",
          reason: "value_out_of_range",
          range: { min: 0, max, unit: "score" },
        },
      });
    }
    expect(
      checkAppleHealthAssessment({ ...base, instrument: "GAD7", value: 21 }).ok,
    ).toBe(true);
  });

  it("refuses an implausible instant", () => {
    const verdict = checkAppleHealthAssessment({
      ...base,
      startDate: "2999-01-01T00:00:00.000Z",
    });
    expect(verdict.ok || verdict.result.reason).toBe("implausible_timestamp");
  });
});
