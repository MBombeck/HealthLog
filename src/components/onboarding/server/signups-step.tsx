"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import { useAdminSettings } from "@/components/admin/_shared";
import { apiPut } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { useServerStep } from "./use-server-step";

type Signups = "invited" | "anyone";

/**
 * Who may create an account. The claim already left the server at "invited
 * people only" (the first-account write turns open sign-up off), so the
 * sentence says that is the state, and the row shows it chosen. An invite
 * always works; "anyone" opens the registration form to whoever reaches the
 * server. Written through the general admin settings route.
 */
export function SignupsStep() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const settings = useAdminSettings();
  const step = useServerStep("signups");
  const [choice, setChoice] = useState<Signups | null>(null);
  const [working, setWorking] = useState(false);
  const current: Signups | null = settings.data
    ? settings.data.registrationEnabled
      ? "anyone"
      : "invited"
    : null;
  const selected = choice ?? current;

  async function next() {
    if (!selected || working) return;
    setWorking(true);
    try {
      if (selected !== current) {
        await apiPut("/api/admin/settings", {
          registrationEnabled: selected === "anyone",
        });
        await queryClient.invalidateQueries({
          queryKey: queryKeys.adminSettings(),
        });
      }
      await step.record("done");
    } catch (err) {
      setWorking(false);
      step.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="server-setup-signups-title"
      className="flex flex-1 flex-col"
      data-slot="server-setup-step"
      data-step="signups"
    >
      <StepHeading
        id="server-setup-signups-title"
        title={t("setup.server.signups.title")}
        description={t("setup.server.signups.body")}
      />
      <fieldset className="grid gap-2">
        <legend className="sr-only">{t("setup.server.signups.title")}</legend>
        <ChoiceChip
          name="server-setup-signups"
          value="invited"
          kind="single"
          checked={selected === "invited"}
          onChange={() => setChoice("invited")}
          label={t("setup.server.signups.invited")}
          hint={t("setup.server.signups.invitedHint")}
        />
        <ChoiceChip
          name="server-setup-signups"
          value="anyone"
          kind="single"
          checked={selected === "anyone"}
          onChange={() => setChoice("anyone")}
          label={t("setup.server.signups.anyone")}
        />
      </fieldset>
      <StepActions
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void next(),
          disabled: !selected,
        }}
        pending={working || step.pending}
      />
    </section>
  );
}
