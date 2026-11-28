"use client";

import { useState } from "react";

import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { useAiConsent, useAiProviderState } from "@/hooks/use-ai-capability";
import { useGrantAiConsent } from "@/hooks/use-grant-ai-consent";
import { useModuleToggle } from "@/hooks/use-module-toggle";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";

/**
 * The Coach, yes or no (1.50). Shown only while a provider can serve this
 * record (`offers.ai`). The sentence says what really happens, named from
 * the record's resolved provider: readings go to the service this server is
 * set up with (named), to the person's own key, or to their own model, for
 * the analyses as well as for questions.
 *
 *  - "Yes" gives the AI consent through its own route when the provider
 *    needs one, from this tap and never from a mount or an effect.
 *  - "No" switches the Coach off. It is respected: nothing asks again.
 *
 * The two answers are the action pair; nothing is chosen until one is
 * tapped. This is the flow's last screen for a person's own record, so
 * either answer finishes.
 */
export function AiScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const flow = usePersonFlow(state, plan, "ai");
  const provider = useAiProviderState();
  const consent = useAiConsent();
  const grant = useGrantAiConsent();
  const coachSwitch = useModuleToggle();
  const [working, setWorking] = useState(false);

  const recipients = (consent?.recipients ?? [])
    .map((recipient) => recipient.name)
    .join(", ");
  const where =
    provider.managedBy === "server" && recipients
      ? t("setup.person.ai.whereServer", { providers: recipients })
      : provider.managedBy === "local"
        ? t("setup.person.ai.whereLocal")
        : t("setup.person.ai.whereOwn");

  // "Yes" is the consent act itself when the provider needs one: the tap on
  // this button, never a mount or an effect.
  async function chooseYes() {
    if (working) return;
    setWorking(true);
    try {
      if (consent?.status === "needed") await grant.mutateAsync();
      await flow.advance(await flow.record({ step: "ai" }));
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  async function chooseNo() {
    if (working) return;
    setWorking(true);
    try {
      await coachSwitch.mutateAsync({ key: "coach", enabled: false });
      await flow.advance(await flow.record({ step: "ai" }));
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-ai-title"
      className="flex flex-1 flex-col"
      data-slot="onboarding-ai"
      data-provider={provider.configured ? provider.managedBy : "none"}
    >
      <StepHeading
        id="onboarding-ai-title"
        title={t("onboarding.flow.ai.title")}
        description={where}
        tone="foreground"
      />
      <StepActions
        secondary={{
          label: t("setup.no"),
          onClick: chooseNo,
          slot: "onboarding-ai-no",
        }}
        primary={{
          label: t("setup.yes"),
          onClick: chooseYes,
          slot: "onboarding-ai-yes",
        }}
        pending={working}
      />
    </section>
  );
}
