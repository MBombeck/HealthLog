"use client";

import { useAiProviderState } from "@/hooks/use-ai-capability";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Compass,
  FileUp,
  PlusCircle,
  Plug,
  Settings2,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { StepHeading } from "@/components/onboarding/step-heading";
import { useOnboardingAnswer } from "@/components/onboarding/use-onboarding-flow";
import { useAuth } from "@/hooks/use-auth";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { setTourReferrer } from "@/components/onboarding/tour-launcher";
import { hasOptedOutOfAi } from "@/lib/ai/capabilities/types";
import { useTranslations } from "@/lib/i18n/context";
import { markChecklistExpanded } from "@/lib/onboarding/checklist-storage";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import { accountLabel } from "@/lib/sharing/account-access-view";
import { InlineAction } from "@/components/ui/inline-action";

/**
 * v1.39 — the setup flow's exit.
 *
 * The dashboard is one click away, already ordered, and the checklist opens
 * on arrival (design spec §The screens, 5). The tour is an OFFER here rather
 * than an automatic launch: pressing "Take a short tour" sets the referrer
 * the shell-level `<TourLauncher>` reads, and nothing else does, so somebody
 * who wants the dashboard gets the dashboard.
 *
 * Two record-shaped exits ride the answer to Q1: "both" is offered the
 * profile for the person they look after, and "someone I look after" — whose
 * profile was created on the confirm screen — is offered that record, through
 * the same switch the account menu uses, so their first entry lands in the
 * right record.
 *
 * The step is marked done on arrival, once. Everything else on this screen
 * is presentational: the module map was derived on confirm, the cookie
 * cleared there too.
 *
 * AI gets one line with a link to Settings, AI, and no more: HealthLog is
 * complete without it, and the hint on Insights is where it is offered.
 */

export function DoneScreen({ state }: { state: OnboardingStateDto }) {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const answer = useOnboardingAnswer();
  const accountSwitch = useAccountSwitch();

  // Mark the step once. The write is idempotent, but a strict-mode double
  // mount would still send it twice; the ref keeps it to one.
  const marked = useRef(false);
  const donePending =
    state.steps.find((step) => step.id === "done")?.status === "pending";
  useEffect(() => {
    if (!donePending || marked.current) return;
    marked.current = true;
    answer.mutate({ step: "done" });
    // `answer` is a fresh object every render; the mutation it wraps is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [donePending]);

  const recordTarget = state.needs.recordTarget;
  const managedRecord =
    recordTarget === "someone-else"
      ? (user?.accountAccess?.accounts.find(
          (entry) => entry.recordKind === "managed",
        ) ?? null)
      : null;

  function openDashboard() {
    markChecklistExpanded();
    router.push("/");
  }

  function takeTour() {
    if (user?.id) setTourReferrer(user.id);
    markChecklistExpanded();
    router.push("/");
  }

  // One quiet line, only while this person could set AI up here, has no
  // provider yet and has not switched the Coach and AI analysis off: the same
  // rule as the Insights hint, which stays the one place that invites. With
  // nothing to offer the screen goes from "done" straight to the exits.
  const provider = useAiProviderState();
  const showAiLine =
    !provider.configured &&
    provider.canConfigure &&
    !hasOptedOutOfAi(user?.modules);

  return (
    <section
      aria-labelledby="onboarding-done-title"
      className="flex flex-col items-center gap-6 py-6 text-center"
    >
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex size-20 items-center justify-center rounded-full"
      >
        <CheckCircle2 className="size-10" />
      </span>

      <div className="mx-auto max-w-md space-y-2">
        <StepHeading
          id="onboarding-done-title"
          title={t("onboarding.done.title")}
          description={t("onboarding.done.body")}
        />
        <p className="text-muted-foreground text-sm leading-relaxed">
          {t("onboarding.done.learning")}
        </p>
      </div>

      {showAiLine ? (
        <p data-slot="onboarding-ai-line" className="max-w-md text-sm">
          {t("onboarding.done.aiOptional")}{" "}
          <InlineAction asChild size="sm" className="underline">
            <Link href="/settings/ai">{t("onboarding.done.aiSetupCta")}</Link>
          </InlineAction>
        </p>
      ) : null}

      <div className="flex w-full max-w-xs flex-col gap-2">
        <Button
          type="button"
          size="lg"
          onClick={openDashboard}
          className="min-h-11"
          data-slot="onboarding-open-dashboard"
        >
          {t("onboarding.done.returnCta")}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          onClick={takeTour}
          className="inline-flex min-h-11 items-center gap-2"
          data-slot="onboarding-take-tour"
        >
          <Compass className="size-4" />
          {t("onboarding.flow.done.tourCta")}
        </Button>
        {managedRecord ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => accountSwitch.mutate(managedRecord.accountId)}
            disabled={accountSwitch.isPending}
            className="inline-flex min-h-11 items-center gap-2"
            data-slot="onboarding-open-managed-record"
          >
            <UserPlus className="size-4" />
            {t("onboarding.flow.done.openRecord", {
              name: accountLabel(managedRecord),
            })}
          </Button>
        ) : null}
        {recordTarget === "both" ? (
          <Button asChild size="lg" variant="outline">
            <Link
              href="/settings/access"
              className="inline-flex min-h-11 items-center gap-2"
              data-slot="onboarding-create-managed-profile"
            >
              <UserPlus className="size-4" />
              {t("onboarding.flow.done.createProfile")}
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost">
          <Link
            href="/settings/integrations"
            className="inline-flex items-center gap-2"
          >
            <Plug className="size-4" />
            {t("onboarding.done.connectCta")}
          </Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/measurements" className="inline-flex items-center gap-2">
            <PlusCircle className="size-4" />
            {t("onboarding.done.logCta")}
          </Link>
        </Button>
      </div>

      {/* 2026-07-17 UX-onboarding audit M5 — the module system (default-on
          set + opt-ins like nutrients / mental health / documents) is
          otherwise undiscoverable during first-run: the wizard never
          mentions it, and the only pointer used to be one tour stop.
          A quiet link here, beside the existing import link, gives every
          new account one honest pointer to Settings → Modules before they
          leave the wizard. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        <InlineAction
          asChild
          tone="muted"
          size="sm"
          className="gap-1.5 underline"
        >
          <Link href="/settings/export">
            <FileUp className="size-3.5" />
            {t("onboarding.done.importCta")}
          </Link>
        </InlineAction>
        <InlineAction
          asChild
          tone="muted"
          size="sm"
          className="gap-1.5 underline"
        >
          <Link href="/settings/modules">
            <Settings2 className="size-3.5" />
            {t("onboarding.done.modulesCta")}
          </Link>
        </InlineAction>
      </div>
    </section>
  );
}
