"use client";

import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  DISCLAIMER_VERSION,
  isDisclaimerAcknowledgmentCurrent,
} from "@/lib/onboarding/disclaimer";
import {
  ONBOARDING_RECORD_TARGETS,
  type OnboardingRecordTarget,
  type OnboardingStateDto,
} from "@/lib/onboarding/needs";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";
import { queryKeys } from "@/lib/query-keys";

/** Answers that carry a second line under the label. */
const HINTS: Partial<Record<OnboardingRecordTarget, string>> = {
  "someone-else": "onboarding.flow.who.hints.someone-else",
  both: "onboarding.flow.who.hints.both",
};

/**
 * The first screen: whose record this is, and the medical disclaimer.
 *
 * Nothing is chosen up front, and "Continue" waits for both an answer and
 * the disclaimer; an account that acknowledged the current version already
 * sees it ticked. The answer pins the flow's segments on the server.
 */
export function WhoScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const flow = usePersonFlow(state, plan, "who");
  const disclaimerId = useId();
  const [selected, setSelected] = useState<OnboardingRecordTarget | null>(
    state.needs.recordTarget,
  );
  const disclaimerCurrent = isDisclaimerAcknowledgmentCurrent(
    user?.disclaimerAcknowledgedAt,
    user?.disclaimerAcknowledgedVersion,
  );
  const [acknowledged, setAcknowledged] = useState(disclaimerCurrent);
  const [working, setWorking] = useState(false);

  async function next() {
    if (!selected || !acknowledged || working) return;
    setWorking(true);
    try {
      if (!disclaimerCurrent) {
        await apiPost("/api/onboarding/disclaimer", {
          version: DISCLAIMER_VERSION,
        });
        await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
      }
      const written = await flow.record({
        step: "who",
        recordTarget: selected,
      });
      // The plan is pinned from this answer on the server; the next page
      // reads it, so the stepper there already shows the right segments.
      await flow.advance(written);
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-who-title"
      className="flex flex-1 flex-col"
    >
      <StepHeading
        id="onboarding-who-title"
        title={t("onboarding.flow.who.title")}
        description={t("onboarding.flow.who.body")}
      />
      <fieldset className="grid gap-2" data-slot="onboarding-question-who">
        <legend className="sr-only">{t("onboarding.flow.who.title")}</legend>
        {ONBOARDING_RECORD_TARGETS.map((option) => {
          const hint = HINTS[option];
          return (
            <ChoiceChip
              key={option}
              name="onboarding-who"
              value={option}
              kind="single"
              checked={selected === option}
              onChange={() => setSelected(option)}
              label={t(`onboarding.flow.who.options.${option}`)}
              hint={hint ? t(hint) : undefined}
            />
          );
        })}
      </fieldset>

      <div
        className="mt-6 flex items-start gap-3"
        data-slot="onboarding-disclaimer"
      >
        <Checkbox
          id={disclaimerId}
          checked={acknowledged}
          onCheckedChange={(next) => setAcknowledged(next === true)}
          className="mt-0.5"
          disabled={disclaimerCurrent}
        />
        <Label
          htmlFor={disclaimerId}
          noColon
          className="text-foreground text-sm leading-relaxed font-normal"
        >
          {t("onboarding.disclaimer.acknowledge")}
        </Label>
      </div>

      <StepActions
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void next(),
          disabled: !selected || !acknowledged,
        }}
        pending={working}
      />
    </section>
  );
}
