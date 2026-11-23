"use client";

import { useRouter } from "next/navigation";

import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
} from "@/components/onboarding/use-onboarding-flow";
import { NotificationChannelsPanel } from "@/components/settings/integrations/notification-channels-panel";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import { nextScreen, previousScreen } from "@/lib/onboarding/wizard-steps";

/**
 * 1.49 — the `reminders` follow-up: where reminders arrive.
 *
 * Shown after confirm, and only to a record with a medication schedule or an
 * area that has reminders of its own (the step machine decides). It is the
 * Settings channel panel itself, so this server's channels show exactly as
 * they do there: a channel the operator switched off is not offered, email
 * only when the server can send it. Nothing is asked of the browser until a
 * card's own button is tapped, which is where Web Push asks for permission.
 *
 * The step writes nothing of its own: each card saves through its route, and
 * "Continue" and "Skip" only record the step on the ledger. The snooze length
 * stays in Settings → Notifications, beside the reminders it applies to.
 */
export function RemindersScreen({ state }: { state: OnboardingStateDto }) {
  const { t } = useTranslations();
  const router = useRouter();
  const answer = useOnboardingAnswer();
  const back = previousScreen(state, "reminders");

  async function persist(
    input: { step: "reminders" } | { step: "reminders"; status: "skipped" },
  ) {
    try {
      const written = await answer.mutateAsync(input);
      router.push(screenHref(nextScreen(written, "reminders") ?? "done"));
    } catch (err) {
      showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
        cause: err,
      });
    }
  }

  return (
    <section
      aria-labelledby="onboarding-reminders-title"
      className="space-y-6"
      data-slot="onboarding-reminders"
    >
      <StepHeading
        id="onboarding-reminders-title"
        title={t("onboarding.flow.reminders.title")}
        description={t("onboarding.flow.reminders.body")}
      />
      <p className="text-sm">{t("onboarding.flow.reminders.app")}</p>

      <NotificationChannelsPanel />

      <StepActions
        backHref={back ? screenHref(back) : undefined}
        onSkip={() => void persist({ step: "reminders", status: "skipped" })}
        onNext={() => void persist({ step: "reminders" })}
        pending={answer.isPending}
      />
    </section>
  );
}
