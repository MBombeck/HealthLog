/**
 * v1.39 (C1) — applying one answered step to the stored onboarding state.
 *
 * Pure, so the idempotence claim is checkable without a database: applying the
 * same body twice returns a value equal to applying it once, which is what
 * `PATCH /api/onboarding/answers` promises. The route reads the row, calls
 * this, and writes the result back; nothing about "what an answer means" lives
 * in the route.
 *
 * Kept beside the vocabulary rather than inside it so `needs.ts` keeps
 * depending on nothing but the module registry — this file is the one place
 * that knows both the stored shape and the request shape.
 */
import type { OnboardingAnswerInput } from "@/lib/validations/onboarding-needs";

import type {
  OnboardingFirstResult,
  OnboardingNeeds,
  OnboardingStepId,
  OnboardingStepState,
  OnboardingStepStatus,
} from "./needs";

export interface OnboardingRecordState {
  needs: OnboardingNeeds;
  steps: OnboardingStepState[];
  firstResult: OnboardingFirstResult | null;
}

/**
 * The two list answers are stored as given, and a client that sends the same
 * chip twice would otherwise leave the column holding something the reader
 * never returns — `parseOnboardingNeeds` de-duplicates on the way out.
 */
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function withStatus(
  steps: readonly OnboardingStepState[],
  id: OnboardingStepId,
  status: OnboardingStepStatus,
): OnboardingStepState[] {
  return steps.map((step) => (step.id === id ? { ...step, status } : step));
}

/**
 * Apply one answer.
 *
 * A skip records the pass and leaves the answers exactly as they were: the
 * spec's principle is that nothing is lost by a choice, and a person who
 * answered Q2, went back and then skipped it should not have their areas
 * erased by the skip. `now` is injected so the first-result stamp is the
 * server's instant and the test can pin it.
 */
export function applyOnboardingAnswer(
  state: OnboardingRecordState,
  input: OnboardingAnswerInput,
  now: Date,
): OnboardingRecordState {
  if ("status" in input && input.status === "skipped") {
    return { ...state, steps: withStatus(state.steps, input.step, "skipped") };
  }

  const steps = withStatus(state.steps, input.step, "done");

  switch (input.step) {
    case "who":
      return {
        ...state,
        steps,
        needs: { ...state.needs, recordTarget: input.recordTarget },
      };
    case "areas":
      return {
        ...state,
        steps,
        needs: { ...state.needs, areas: unique(input.areas) },
      };
    case "medication":
      return {
        ...state,
        steps,
        needs: { ...state.needs, medication: input.medication },
      };
    case "sources":
      return {
        ...state,
        steps,
        needs: { ...state.needs, sources: unique(input.sources) },
      };
    case "visit":
      return { ...state, steps, needs: { ...state.needs, visit: input.visit } };
    case "units":
      return {
        ...state,
        steps,
        needs: {
          ...state.needs,
          units: {
            // An omitted field leaves the recorded answer alone; an explicit
            // `null` clears it. The two cases are different on purpose — the
            // screen may set one unit without the other.
            glucoseUnit:
              input.units.glucoseUnit === undefined
                ? state.needs.units.glucoseUnit
                : input.units.glucoseUnit,
            unitPreference:
              input.units.unitPreference === undefined
                ? state.needs.units.unitPreference
                : input.units.unitPreference,
          },
        },
      };
    case "first-result": {
      const already =
        state.firstResult?.task === input.firstResult.task
          ? state.firstResult.completedAt
          : null;
      return {
        ...state,
        steps,
        firstResult: {
          task: input.firstResult.task,
          target: input.firstResult.target ?? null,
          // Stamped once. A repeat of the same completed task keeps the
          // instant it already had, which is what makes the write idempotent
          // rather than merely repeatable.
          completedAt: input.firstResult.completed
            ? (already ?? now.toISOString())
            : already,
        },
      };
    }
    case "confirm":
    case "done":
      return { ...state, steps };
  }
}
