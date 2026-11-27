"use client";

import { useRouter } from "next/navigation";

import {
  useOnboardingAnswer,
  useOnboardingComplete,
} from "@/components/onboarding/use-onboarding-flow";
import { screenHref } from "@/components/onboarding/screen-href";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { OnboardingAnswerInput } from "@/lib/validations/onboarding-needs";
import {
  nextScreen,
  questionsToPassBeforeConfirm,
  type FlowState,
  type OnboardingScreenId,
  type PersonSegmentId,
} from "@/lib/onboarding/wizard-steps";

/**
 * The writes a person setup screen makes, and where it goes after them
 * (1.50). Every write answers the flow's state as the server wrote it, and
 * "where next" is read off THAT, never off what the screen thinks it did.
 */
export function usePersonFlow(
  state: OnboardingStateDto,
  plan: readonly PersonSegmentId[] | null,
  screen: OnboardingScreenId,
) {
  const { t } = useTranslations();
  const router = useRouter();
  const answer = useOnboardingAnswer();
  const complete = useOnboardingComplete();

  const withPlan = (written: OnboardingStateDto): FlowState => ({
    ...written,
    plan,
  });

  /** Record one answer; returns the written state. */
  const record = (input: OnboardingAnswerInput) => answer.mutateAsync(input);

  /**
   * Confirm the answers: pass every question this flow does not ask, then
   * complete, which derives the module map once (for the managed profile
   * when one was created for "someone I look after") and ends the first-run
   * redirect.
   */
  async function confirmAnswers(
    written: OnboardingStateDto,
    managedRecordId?: string,
  ): Promise<OnboardingStateDto> {
    let current = written;
    for (const id of questionsToPassBeforeConfirm(withPlan(current))) {
      current = await record({ step: id, status: "skipped" });
    }
    const result = await complete.mutateAsync(
      managedRecordId ? { managedRecordId } : undefined,
    );
    current = result.onboarding ?? current;
    if (stepPending(current, "first-result")) {
      current = await record({ step: "first-result", status: "skipped" });
    }
    return current;
  }

  /** The flow's last screen: settle the ledger and open the dashboard. */
  async function finish(written: OnboardingStateDto): Promise<void> {
    if (stepPending(written, "done")) await record({ step: "done" });
    router.push("/");
    router.refresh();
  }

  /** Go on from this screen, or finish when it was the last one. */
  async function advance(written: OnboardingStateDto): Promise<void> {
    const next = nextScreen(withPlan(written), screen);
    if (next) {
      router.push(screenHref(next));
      return;
    }
    await finish(written);
  }

  function fail(err: unknown) {
    showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
      cause: err,
    });
  }

  return {
    record,
    confirmAnswers,
    finish,
    advance,
    fail,
    pending: answer.isPending || complete.isPending,
  };
}

function stepPending(state: OnboardingStateDto, id: string): boolean {
  return state.steps.find((step) => step.id === id)?.status === "pending";
}
