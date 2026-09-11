/**
 * v1.39 (C2) — the five chip questions, as data.
 *
 * Which step asks what, with which answers, whether one answer or many, and
 * whether it may be skipped — and the two pure translations the screen needs:
 * the stored answers into a selection to prefill, and a selection into the
 * body `PATCH /api/onboarding/answers` accepts. Both are here rather than in
 * the component so they can be pinned without a DOM, and so the body that
 * reaches the wire is built field by field from a closed vocabulary rather
 * than from whatever the chips happened to hold.
 *
 * The answer vocabularies are the server's (`./needs`, the registry); this
 * file only orders them and names their labels. Units (Q6) is not a chip
 * set and has its own screen.
 */
import { ONBOARDING_AREA_KEYS } from "@/lib/modules/registry";
import type { OnboardingAnswerInput } from "@/lib/validations/onboarding-needs";

import {
  ONBOARDING_MEDICATION_ANSWERS,
  ONBOARDING_RECORD_TARGETS,
  ONBOARDING_SOURCE_KEYS,
  ONBOARDING_VISIT_ANSWERS,
  type OnboardingNeeds,
} from "./needs";

export const QUESTION_STEP_IDS = [
  "who",
  "areas",
  "medication",
  "sources",
  "visit",
] as const;

export type QuestionStepId = (typeof QUESTION_STEP_IDS)[number];

export function isQuestionStepId(value: string): value is QuestionStepId {
  return (QUESTION_STEP_IDS as readonly string[]).includes(value);
}

export interface QuestionDefinition {
  /** One answer (radio) or any number (checkbox). */
  kind: "single" | "multi";
  /** Q1 is the one question that cannot be passed. */
  skippable: boolean;
  /** The answer values, in the order they are offered. */
  options: readonly string[];
}

export const QUESTIONS: Readonly<Record<QuestionStepId, QuestionDefinition>> =
  Object.freeze({
    who: {
      kind: "single",
      skippable: false,
      options: ONBOARDING_RECORD_TARGETS,
    },
    areas: { kind: "multi", skippable: true, options: ONBOARDING_AREA_KEYS },
    medication: {
      kind: "single",
      skippable: true,
      options: ONBOARDING_MEDICATION_ANSWERS,
    },
    sources: {
      kind: "multi",
      skippable: true,
      options: ONBOARDING_SOURCE_KEYS,
    },
    visit: {
      kind: "single",
      skippable: true,
      options: ONBOARDING_VISIT_ANSWERS,
    },
  });

/** The i18n key of one answer chip. */
export function questionOptionLabelKey(
  step: QuestionStepId,
  option: string,
): string {
  return `onboarding.flow.${step}.options.${option}`;
}

/** The stored answers of one step, as the chips to pre-select. */
export function questionPrefill(
  step: QuestionStepId,
  needs: OnboardingNeeds,
): string[] {
  switch (step) {
    case "who":
      return needs.recordTarget ? [needs.recordTarget] : [];
    case "areas":
      return [...needs.areas];
    case "medication":
      return needs.medication ? [needs.medication] : [];
    case "sources":
      return [...needs.sources];
    case "visit":
      return needs.visit ? [needs.visit] : [];
  }
}

function only<T extends string>(
  values: readonly T[],
  selected: readonly string[],
): T[] {
  return selected.filter((value): value is T =>
    (values as readonly string[]).includes(value),
  );
}

/**
 * The body for one answered step, or null when the selection cannot be an
 * answer. Every arm names its field; a value that is not in the step's
 * vocabulary is dropped rather than sent, so the strict server schema never
 * sees a chip this file did not offer.
 *
 * v1.39 — an empty tick list is not an answer either. The many-answer arms
 * used to send `[]` and mark the step DONE, and an
 * answered Q2 with no areas is what switched every optional module off for
 * somebody whose click meant "no preference". Skip is the way past a question
 * nobody wants to answer, and Skip is the conservative derivation.
 */
export function questionAnswerBody(
  step: QuestionStepId,
  selected: readonly string[],
): OnboardingAnswerInput | null {
  switch (step) {
    case "who": {
      const [recordTarget] = only(ONBOARDING_RECORD_TARGETS, selected);
      return recordTarget ? { step, recordTarget } : null;
    }
    case "areas": {
      const areas = only(ONBOARDING_AREA_KEYS, selected);
      return areas.length > 0 ? { step, areas } : null;
    }
    case "medication": {
      const [medication] = only(ONBOARDING_MEDICATION_ANSWERS, selected);
      return medication ? { step, medication } : null;
    }
    case "sources": {
      const sources = only(ONBOARDING_SOURCE_KEYS, selected);
      return sources.length > 0 ? { step, sources } : null;
    }
    case "visit": {
      const [visit] = only(ONBOARDING_VISIT_ANSWERS, selected);
      return visit ? { step, visit } : null;
    }
  }
}

/** The body that passes one skippable step without answering it. */
export function questionSkipBody(
  step: Exclude<QuestionStepId, "who">,
): OnboardingAnswerInput {
  return { step, status: "skipped" };
}

/**
 * Q6 — which of the two unit questions this flow asks. Glucose needs a
 * glucose unit, weight needs the metric/imperial preference; an area not
 * ticked is not asked about, so a person who chose only glucose never sees
 * "kg or lb".
 */
export function unitQuestionsFor(needs: OnboardingNeeds): {
  glucose: boolean;
  weight: boolean;
} {
  return {
    glucose: needs.areas.includes("glucose"),
    weight: needs.areas.includes("weight-body"),
  };
}

/**
 * The Q6 body. Only the questions that were asked reach the wire, and only
 * with a chosen value: an omitted field leaves the account's own column
 * alone, which is what "never re-ask a value the account holds" needs when
 * a person confirms the one they already had.
 */
export function unitsAnswerBody(input: {
  asked: { glucose: boolean; weight: boolean };
  glucoseUnit: "mg/dL" | "mmol/L" | null;
  unitPreference: "metric" | "imperial" | null;
}): OnboardingAnswerInput | null {
  const units: {
    glucoseUnit?: "mg/dL" | "mmol/L";
    unitPreference?: "metric" | "imperial";
  } = {};
  if (input.asked.glucose && input.glucoseUnit) {
    units.glucoseUnit = input.glucoseUnit;
  }
  if (input.asked.weight && input.unitPreference) {
    units.unitPreference = input.unitPreference;
  }
  // v1.39 — nothing chosen is not an answer: an empty
  // units body marked Q6 done while recording no preference at all.
  return Object.keys(units).length > 0 ? { step: "units", units } : null;
}
