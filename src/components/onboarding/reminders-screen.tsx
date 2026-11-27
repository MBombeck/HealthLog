"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Monitor, Smartphone } from "lucide-react";

import { ChoiceChip } from "@/components/onboarding/choice-chip";
import { usePersonFlow } from "@/components/onboarding/person-flow";
import { StepActions } from "@/components/onboarding/step-actions";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  subscribeOutcomeMessage,
  subscribeThisBrowser,
} from "@/components/settings/web-push-card";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import type { PersonSegmentId } from "@/lib/onboarding/wizard-steps";
import { queryKeys } from "@/lib/query-keys";

type Channel = "app" | "browser";

/** This browser can take a push: the API exists and it is not blocked. */
function browserCanPush(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    Notification.permission !== "denied"
  );
}

/**
 * Where reminders reach the person: one way now, more later (1.50).
 *
 *  - The iPhone app: through the HealthLog push relay while the server uses
 *    it, otherwise the app reminds on the phone itself. Nothing is written
 *    here; the app registers itself when it signs in.
 *  - This browser: offered while the server can send Web Push and the
 *    browser can take it. The permission is asked on "Continue", which is
 *    why the line under it says so: this screen is the warning before the
 *    browser's own prompt. A "no" at that prompt is respected and the flow
 *    goes on.
 *
 * Telegram and ntfy need a token from somewhere else, so they are a line,
 * not a choice; they wait on the setup card.
 */
export function RemindersScreen({
  state,
  plan,
}: {
  state: OnboardingStateDto;
  plan: readonly PersonSegmentId[] | null;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const flow = usePersonFlow(state, plan, "reminders");
  const mounted = useMounted();
  const vapid = useQuery({
    queryKey: queryKeys.notificationsVapid(),
    queryFn: async () => (await apiFetchRaw("/api/notifications/vapid")).ok,
    staleTime: 5 * 60_000,
  });
  const browserOffered = mounted && vapid.data === true && browserCanPush();
  const relayOn = user?.push?.relay?.operatorDecision === "on";

  const [choice, setChoice] = useState<Channel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function persist(skip: boolean) {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      if (!skip && choice === "browser") {
        const outcome = await subscribeThisBrowser();
        // A refusal at the browser's prompt is an answer; anything else that
        // went wrong keeps the person here with the reason.
        if (outcome !== "subscribed" && outcome !== "denied") {
          setError(subscribeOutcomeMessage(outcome, t));
          setWorking(false);
          return;
        }
      }
      const written = await flow.record(
        skip ? { step: "reminders", status: "skipped" } : { step: "reminders" },
      );
      await flow.advance(written);
    } catch (err) {
      setWorking(false);
      flow.fail(err);
    }
  }

  return (
    <section
      aria-labelledby="onboarding-reminders-title"
      className="flex flex-1 flex-col"
      data-slot="onboarding-reminders"
    >
      <StepHeading
        id="onboarding-reminders-title"
        title={t("onboarding.flow.reminders.title")}
        description={t("setup.person.reminders.body")}
      />
      <fieldset
        className="grid gap-2"
        data-slot="onboarding-question-reminders"
      >
        <legend className="sr-only">
          {t("onboarding.flow.reminders.title")}
        </legend>
        <ChoiceChip
          name="onboarding-reminders"
          value="app"
          kind="single"
          checked={choice === "app"}
          onChange={() => setChoice("app")}
          label={t("setup.person.reminders.app")}
          hint={t(
            relayOn
              ? "setup.person.reminders.appRelay"
              : "setup.person.reminders.appLocal",
          )}
          Icon={Smartphone}
        />
        {browserOffered ? (
          <ChoiceChip
            name="onboarding-reminders"
            value="browser"
            kind="single"
            checked={choice === "browser"}
            onChange={() => setChoice("browser")}
            label={t("setup.person.reminders.browser")}
            hint={t("setup.person.reminders.browserHint")}
            Icon={Monitor}
          />
        ) : null}
      </fieldset>
      <p className="text-muted-foreground mt-4 text-xs">
        {t("setup.person.reminders.tokens")}
      </p>
      {error ? (
        <p
          role="alert"
          className="text-destructive mt-4 text-sm"
          data-slot="onboarding-reminders-error"
        >
          {error}
        </p>
      ) : null}
      <StepActions
        secondary={{
          label: t("setup.notNow"),
          onClick: () => void persist(true),
        }}
        primary={{
          label: t("onboarding.shell.next"),
          onClick: () => void persist(false),
          disabled: choice === null,
        }}
        pending={working}
      />
    </section>
  );
}
