/**
 * v1.39 (C2) — the chip questions as data, and the two translations the
 * screen relies on: stored answers → chips to pre-select, and a selection →
 * the strict body the answers route accepts.
 */
import { describe, expect, it } from "vitest";

import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import { onboardingAnswerSchema } from "@/lib/validations/onboarding-needs";

import { emptyOnboardingNeeds, ONBOARDING_SOURCE_KEYS } from "../needs";
import {
  QUESTION_STEP_IDS,
  QUESTIONS,
  questionAnswerBody,
  questionPrefill,
  questionSkipBody,
  unitQuestionsFor,
  unitsAnswerBody,
} from "../question-config";

describe("QUESTIONS", () => {
  it("offers every value of each server vocabulary, in the server's order", () => {
    expect(QUESTIONS.areas.options).toEqual(ONBOARDING_AREA_KEYS);
    expect(QUESTIONS.sources.options).toEqual(ONBOARDING_SOURCE_KEYS);
    expect(QUESTIONS.who.options).toEqual(["me", "someone-else", "both"]);
  });

  it("makes Q1 the one question that cannot be passed", () => {
    expect(QUESTIONS.who.skippable).toBe(false);
    for (const step of QUESTION_STEP_IDS.filter((s) => s !== "who")) {
      expect(QUESTIONS[step].skippable).toBe(true);
    }
  });
});

describe("questionPrefill", () => {
  it("reads the stored answer of each step back as a selection", () => {
    const needs = {
      ...emptyOnboardingNeeds(),
      recordTarget: "both" as const,
      areas: ["glucose" as const, "mood" as const],
      medication: "sometimes" as const,
      sources: ["oura" as const],
      visit: "later" as const,
    };
    expect(questionPrefill("who", needs)).toEqual(["both"]);
    expect(questionPrefill("areas", needs)).toEqual(["glucose", "mood"]);
    expect(questionPrefill("medication", needs)).toEqual(["sometimes"]);
    expect(questionPrefill("sources", needs)).toEqual(["oura"]);
    expect(questionPrefill("visit", needs)).toEqual(["later"]);
  });

  it("is empty for a question never answered", () => {
    const needs = emptyOnboardingNeeds();
    for (const step of QUESTION_STEP_IDS) {
      expect(questionPrefill(step, needs)).toEqual([]);
    }
  });
});

describe("questionAnswerBody", () => {
  it("builds a body the answers route accepts, for every step", () => {
    const bodies = [
      questionAnswerBody("who", ["me"]),
      questionAnswerBody("areas", ["glucose", "labs"]),
      questionAnswerBody("medication", ["yes"]),
      questionAnswerBody("sources", ["manual", "withings"]),
      questionAnswerBody("visit", ["within-a-month"]),
    ];
    for (const body of bodies) {
      expect(body).not.toBeNull();
      expect(onboardingAnswerSchema.safeParse(body).success).toBe(true);
    }
  });

  it("is null for a single-answer question with nothing chosen", () => {
    expect(questionAnswerBody("who", [])).toBeNull();
    expect(questionAnswerBody("medication", [])).toBeNull();
    expect(questionAnswerBody("visit", [])).toBeNull();
  });

  it("is null for a many-answer question with nothing chosen", () => {
    // An empty tick list is not an opinion. It used to be sent as an
    // ANSWER, and an answered Q2 with no areas is what switched every
    // optional module off for somebody who meant "no preference" — Skip is
    // the way past, and Skip is the conservative derivation.
    expect(questionAnswerBody("areas", [])).toBeNull();
    expect(questionAnswerBody("sources", [])).toBeNull();
    // A list of values none of which the step offers is just as empty.
    expect(questionAnswerBody("areas", ["no-such-area"])).toBeNull();
  });

  it("drops a value the step's vocabulary does not contain", () => {
    expect(questionAnswerBody("areas", ["glucose", "no-such-area"])).toEqual({
      step: "areas",
      areas: ["glucose"],
    });
    expect(questionAnswerBody("who", ["nobody"])).toBeNull();
  });

  it("passes a step with the skip arm and nothing else", () => {
    const body = questionSkipBody("visit");
    expect(body).toEqual({ step: "visit", status: "skipped" });
    expect(onboardingAnswerSchema.safeParse(body).success).toBe(true);
  });
});

describe("units", () => {
  it("asks only about the units the ticked areas need", () => {
    expect(
      unitQuestionsFor({ ...emptyOnboardingNeeds(), areas: ["glucose"] }),
    ).toEqual({ glucose: true, weight: false });
    expect(
      unitQuestionsFor({
        ...emptyOnboardingNeeds(),
        areas: ["weight-body", "glucose"],
      }),
    ).toEqual({ glucose: true, weight: true });
  });

  it("sends only the units that were asked and chosen", () => {
    const body = unitsAnswerBody({
      asked: { glucose: true, weight: false },
      glucoseUnit: "mmol/L",
      unitPreference: "imperial",
    });
    expect(body).toEqual({ step: "units", units: { glucoseUnit: "mmol/L" } });
    expect(onboardingAnswerSchema.safeParse(body).success).toBe(true);
  });

  it("is null when nothing was chosen, so Skip is the way past", () => {
    // An empty units answer marked Q6 done without recording a preference.
    expect(
      unitsAnswerBody({
        asked: { glucose: true, weight: true },
        glucoseUnit: null,
        unitPreference: null,
      }),
    ).toBeNull();
    // One of two asked questions answered is still an answer.
    expect(
      unitsAnswerBody({
        asked: { glucose: true, weight: true },
        glucoseUnit: "mg/dL",
        unitPreference: null,
      }),
    ).toEqual({ step: "units", units: { glucoseUnit: "mg/dL" } });
  });
});
