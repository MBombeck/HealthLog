"use client";

import { useState } from "react";

import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { ManagedProfileCreateForm } from "@/components/settings/access/managed-profile-create-form";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";

/**
 * The profile of the person somebody looks after, created at the end of the
 * flow (the answer to "who" said so). The managed-profile form is the one
 * Settings › Shared access uses, with the flow's own action pair.
 *
 *  - "Someone I look after": the answers describe that record, so they are
 *    confirmed here with the new record's id and land on it; the account's
 *    own modules stay as they are. "Later" confirms without a record, and
 *    nothing is derived onto anybody.
 *  - "Both": the answers were the account's own and are confirmed already;
 *    the profile is the last thing, and "Later" leaves it for the setup card.
 */
export function ProfileScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const flow = usePersonFlow(state, plan, "profile");
  const forSomeoneElse = state.needs.recordTarget === "someone-else";
  const [working, setWorking] = useState(false);

  async function done(managedRecordId?: string) {
    if (working) return;
    setWorking(true);
    try {
      // For "someone I look after" this screen is the confirm: the server
      // derives the answers onto the new profile (or onto nobody, on
      // "Later") once it is answered.
      const written = forSomeoneElse
        ? await flow.record(
            managedRecordId
              ? { step: "confirm", managedRecordId }
              : { step: "confirm" },
          )
        : state;
      await flow.finish(written);
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-profile-title"
      className="flex flex-1 flex-col"
      data-slot="onboarding-profile"
    >
      <StepHeading
        id="onboarding-profile-title"
        title={t("setup.person.profile.title")}
        description={t("setup.person.profile.body")}
      />
      <ManagedProfileCreateForm
        noColons
        onCreated={(profile) => void done(profile.id)}
        renderActions={({ disabled, pending }) => (
          <StepActions
            secondary={{
              label: t("setup.later"),
              onClick: () => void done(),
              slot: "onboarding-profile-later",
            }}
            primary={{
              label: t("setup.person.profile.create"),
              submit: true,
              disabled,
            }}
            pending={pending || working}
          />
        )}
      />
    </section>
  );
}
