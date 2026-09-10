/**
 * v1.39 (C1) — what `PATCH /api/onboarding/answers` will and will not accept.
 *
 * The union has an answer arm per step and a skip arm for six of the nine, and
 * the split is a decision rather than a shape: `who` is the one required
 * question, and `confirm` / `done` are acknowledgements. A skip arm added to
 * one of those three would let a client record a pass through a screen that
 * does not offer one, so the arms are checked against
 * `ONBOARDING_SKIPPABLE_STEP_IDS` rather than against a list written twice.
 *
 * The other property here is that a skip can never carry an answer. That is
 * what makes "skipped, and my areas are …" unrepresentable rather than merely
 * discouraged, and it is why the route can trust the parsed body without
 * re-checking the combination.
 */
import { describe, expect, it } from "vitest";

import {
  ONBOARDING_SKIPPABLE_STEP_IDS,
  ONBOARDING_STEP_IDS,
} from "@/lib/onboarding/needs";
import { onboardingAnswerSchema } from "../onboarding-needs";

const SKIPPABLE: readonly string[] = ONBOARDING_SKIPPABLE_STEP_IDS;

describe("onboardingAnswerSchema", () => {
  it("accepts a skip for exactly the steps that may be passed", () => {
    for (const step of ONBOARDING_STEP_IDS) {
      const parsed = onboardingAnswerSchema.safeParse({
        step,
        status: "skipped",
      });
      expect(
        parsed.success,
        `\`${step}\` ${SKIPPABLE.includes(step) ? "should" : "should not"} be skippable`,
      ).toBe(SKIPPABLE.includes(step));
    }
  });

  it("refuses a skip that carries an answer", () => {
    expect(
      onboardingAnswerSchema.safeParse({
        step: "areas",
        status: "skipped",
        areas: ["sleep"],
      }).success,
    ).toBe(false);
  });

  it("refuses an answer for the wrong step", () => {
    expect(
      onboardingAnswerSchema.safeParse({ step: "areas", medication: "yes" })
        .success,
    ).toBe(false);
  });

  it("refuses a value outside the closed set", () => {
    expect(
      onboardingAnswerSchema.safeParse({ step: "visit", visit: "someday" })
        .success,
    ).toBe(false);
    expect(
      onboardingAnswerSchema.safeParse({ step: "areas", areas: ["astrology"] })
        .success,
    ).toBe(false);
  });

  it("refuses an unknown key alongside a valid answer", () => {
    expect(
      onboardingAnswerSchema.safeParse({
        step: "who",
        recordTarget: "me",
        userId: "someone-else",
      }).success,
    ).toBe(false);
  });

  it("accepts each answered step with its own payload", () => {
    const bodies: unknown[] = [
      { step: "who", recordTarget: "both" },
      { step: "areas", areas: ["glucose", "cycle"] },
      { step: "medication", medication: "sometimes" },
      { step: "sources", sources: ["nightscout", "manual"] },
      { step: "visit", visit: "later" },
      { step: "units", units: { glucoseUnit: "mmol/L" } },
      { step: "confirm" },
      {
        step: "first-result",
        firstResult: {
          task: "log-reading",
          target: "glucose",
          completed: true,
        },
      },
      { step: "done" },
    ];
    expect(bodies.length).toBe(ONBOARDING_STEP_IDS.length);
    for (const body of bodies) {
      expect(
        onboardingAnswerSchema.safeParse(body).success,
        JSON.stringify(body),
      ).toBe(true);
    }
  });
});
