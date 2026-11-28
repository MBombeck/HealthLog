"use client";

import { useRouter } from "next/navigation";

import { useOnboardingAnswer } from "@/components/onboarding/use-onboarding-flow";
import { screenHref } from "@/components/onboarding/screen-href";
import { setTourReferrer } from "@/components/onboarding/tour-launcher";
import { useAuth } from "@/hooks/use-auth";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { OnboardingAnswerInput } from "@/lib/validations/onboarding-needs";
import {
  nextScreen,
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
  const { user } = useAuth();
  const answer = useOnboardingAnswer();

  const withPlan = (written: OnboardingStateDto): FlowState => ({
    ...written,
    plan,
  });

  /** Record one answer; returns the written state. */
  const record = (input: OnboardingAnswerInput) => answer.mutateAsync(input);

  /** The flow's last screen: settle the ledger and open the dashboard. */
  async function finish(written: OnboardingStateDto): Promise<void> {
    // The server confirmed the flow when the last owed screen was answered
    // (`PATCH /api/onboarding/answers`); the ledger's own end is all that is
    // left to settle here.
    if (stepPending(written, "done")) await record({ step: "done" });
    // The module tour follows the first run straight away, not a day later.
    if (user?.id) setTourReferrer(user.id);
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
    finish,
    advance,
    fail,
    pending: answer.isPending,
  };
}

function stepPending(state: OnboardingStateDto, id: string): boolean {
  return state.steps.find((step) => step.id === id)?.status === "pending";
}
