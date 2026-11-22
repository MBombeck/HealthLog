"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingAnswer,
} from "@/components/onboarding/use-onboarding-flow";
import { Button } from "@/components/ui/button";
import { InlineAction } from "@/components/ui/inline-action";
import { useAiConsent, useAiProviderState } from "@/hooks/use-ai-capability";
import { useGrantAiConsent } from "@/hooks/use-grant-ai-consent";
import { useModuleToggle } from "@/hooks/use-module-toggle";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import { nextScreen, previousScreen } from "@/lib/onboarding/wizard-steps";

type CoachChoice = "yes" | "no";

/**
 * 1.49 — the `ai` follow-up: an honest yes or no to the Coach.
 *
 * Shown only while this server offers the Coach to the record (`offers.ai`,
 * resolved on the server from the same capability `/api/auth/me` publishes).
 * The screen says where a question would go, from the record's resolved
 * provider: the services the operator's credential reaches (named), the
 * person's own key, or their own model. It decides nothing itself:
 *
 *  - "Yes" gives the AI consent through its own route when the provider needs
 *    one (`useGrantAiConsent`), and nothing when it does not.
 *  - "No" switches the Coach off through the Coach switch (`disableCoach`).
 *  - "Skip" writes nothing but the step.
 *
 * A key or a local model is entered in Settings → AI, the one place the CSP
 * lets the browser reach an AI host; this screen links there.
 */
export function AiScreen({ state }: { state: OnboardingStateDto }) {
  const { t } = useTranslations();
  const router = useRouter();
  const answer = useOnboardingAnswer();
  const provider = useAiProviderState();
  const consent = useAiConsent();
  const grant = useGrantAiConsent();
  const coachSwitch = useModuleToggle();
  const [working, setWorking] = useState(false);
  const back = previousScreen(state, "ai");

  const recipients = (consent?.recipients ?? [])
    .map((recipient) => recipient.name)
    .join(", ");
  const where = !provider.configured
    ? null
    : provider.managedBy === "server" && recipients
      ? t("onboarding.flow.ai.whereServer", { providers: recipients })
      : provider.managedBy === "local"
        ? t("onboarding.flow.ai.whereLocal")
        : t("onboarding.flow.ai.whereOwn");

  async function record(choice: CoachChoice | "skipped") {
    const written = await answer.mutateAsync(
      choice === "skipped" ? { step: "ai", status: "skipped" } : { step: "ai" },
    );
    router.push(screenHref(nextScreen(written, "ai") ?? "done"));
  }

  function fail(err: unknown) {
    setWorking(false);
    showErrorToast(localizedApiError(err, t, "onboarding.errorGeneric"), {
      cause: err,
    });
  }

  // "Yes" is the consent act itself when the provider needs one: the tap on
  // this button, never a mount or an effect.
  async function chooseYes() {
    if (working) return;
    setWorking(true);
    try {
      if (consent?.status === "needed") await grant.mutateAsync();
      await record("yes");
    } catch (err) {
      fail(err);
    }
  }

  async function chooseNo() {
    if (working) return;
    setWorking(true);
    try {
      await coachSwitch.mutateAsync({ key: "coach", enabled: false });
      await record("no");
    } catch (err) {
      fail(err);
    }
  }

  async function skipStep() {
    if (working) return;
    setWorking(true);
    try {
      await record("skipped");
    } catch (err) {
      fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-ai-title"
      className="space-y-6"
      data-slot="onboarding-ai"
      data-provider={provider.configured ? provider.managedBy : "none"}
    >
      <StepHeading
        id="onboarding-ai-title"
        title={t("onboarding.flow.ai.title")}
        description={t("onboarding.flow.ai.body")}
      />

      <div className="space-y-2" data-slot="onboarding-ai-where">
        {where ? (
          <p className="text-sm">{where}</p>
        ) : (
          <p className="text-sm">
            {t("onboarding.flow.ai.whereNone")}{" "}
            <InlineAction asChild size="sm" className="underline">
              {/* A new tab, so the setup stays where it is. */}
              <Link href="/settings/ai" target="_blank" rel="noopener">
                {t("onboarding.flow.ai.setUp")}
              </Link>
            </InlineAction>
          </p>
        )}
        <p className="text-sm">{t("onboarding.flow.ai.nothingUntilAsked")}</p>
      </div>

      {/* Two answers of equal weight; neither is preselected or styled to
          steer. Skip below records nothing but the step. */}
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
        data-slot="onboarding-question-ai"
      >
        <AnswerButton option="yes" disabled={working} onClick={chooseYes} />
        <AnswerButton option="no" disabled={working} onClick={chooseNo} />
      </div>

      <p className="text-muted-foreground text-xs">
        {t("onboarding.flow.ai.later")}
      </p>

      <StepActions
        backHref={back ? screenHref(back) : undefined}
        onSkip={() => void skipStep()}
        pending={working || answer.isPending}
      />
    </section>
  );
}

function AnswerButton({
  option,
  disabled,
  onClick,
}: {
  option: CoachChoice;
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslations();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      data-slot="onboarding-choice"
      data-value={option}
      className="h-auto min-h-11 flex-col items-start gap-1 py-3 text-left whitespace-normal"
    >
      <span className="text-sm font-medium">
        {t(`onboarding.flow.ai.options.${option}`)}
      </span>
      <span className="text-muted-foreground text-xs font-normal">
        {t(`onboarding.flow.ai.hints.${option}`)}
      </span>
    </Button>
  );
}
