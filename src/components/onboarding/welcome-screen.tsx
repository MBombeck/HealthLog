"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StepHeading } from "@/components/onboarding/step-heading";
import {
  screenHref,
  useOnboardingComplete,
  useOnboardingRestart,
} from "@/components/onboarding/use-onboarding-flow";
import { useAuth } from "@/hooks/use-auth";
import { apiPost } from "@/lib/api/api-fetch";
import { localizedApiError } from "@/lib/api/localized-error";
import { useTranslations } from "@/lib/i18n/context";
import { markChecklistExpanded } from "@/lib/onboarding/checklist-storage";
import {
  DISCLAIMER_VERSION,
  isDisclaimerAcknowledgmentCurrent,
} from "@/lib/onboarding/disclaimer";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.39 (C2) — the screen before the first question.
 *
 * One sentence on what happens and how long it takes, "Set up", and "Skip for
 * now" (design spec §The screens, 1). The skip is a real exit: it stamps the
 * account as past the first-run redirect and lands on the dashboard with the
 * checklist open, and the questions stay one click away in Settings.
 *
 * The one-time medical disclaimer gates BOTH buttons. It used to gate only
 * "Get started", which was fine while the wizard was the only way past this
 * screen; a skip that reached the dashboard without it would be a way round
 * the acknowledgment. Pre-checked only when the account acknowledged the
 * CURRENT version, so a revised disclaimer re-prompts.
 *
 * `variant="again"` is the same screen for an account whose setup is
 * finished: it offers the questions again (through the restart route, which
 * resets the ledger and keeps the answers as prefill) or the dashboard.
 */
export function WelcomeScreen({ variant }: { variant: "fresh" | "again" }) {
  const { t } = useTranslations();
  const router = useRouter();
  const { user } = useAuth();
  const disclaimerId = useId();

  const disclaimerCurrent = isDisclaimerAcknowledgmentCurrent(
    user?.disclaimerAcknowledgedAt,
    user?.disclaimerAcknowledgedVersion,
  );
  const [acknowledged, setAcknowledged] = useState(() => disclaimerCurrent);

  const acknowledge = useMutation({
    mutationKey: queryKeys.onboardingDisclaimerMutation(),
    mutationFn: async () => {
      if (disclaimerCurrent) return;
      await apiPost("/api/onboarding/disclaimer", {
        version: DISCLAIMER_VERSION,
      });
    },
  });
  const complete = useOnboardingComplete();
  const restart = useOnboardingRestart();
  const pending =
    acknowledge.isPending || complete.isPending || restart.isPending;

  const fail = (err: unknown) =>
    toast.error(localizedApiError(err, t, "onboarding.errorGeneric"));

  async function setUp() {
    if (pending || !acknowledged) return;
    try {
      await acknowledge.mutateAsync();
      router.push(screenHref("who"));
    } catch (err) {
      fail(err);
    }
  }

  async function skipForNow() {
    if (pending || !acknowledged) return;
    try {
      await acknowledge.mutateAsync();
      await complete.mutateAsync(undefined);
      markChecklistExpanded();
      router.push("/");
    } catch (err) {
      fail(err);
    }
  }

  async function setUpAgain() {
    if (pending) return;
    try {
      await restart.mutateAsync();
      router.push(screenHref("who"));
    } catch (err) {
      fail(err);
    }
  }

  if (variant === "again") {
    return (
      <section aria-labelledby="onboarding-welcome-title" className="space-y-6">
        <StepHeading
          id="onboarding-welcome-title"
          title={t("onboarding.welcomeBack.title")}
          description={t("onboarding.flow.welcome.againBody")}
        />
        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/">{t("onboarding.welcomeBack.cta")}</Link>
          </Button>
          <Button
            type="button"
            onClick={setUpAgain}
            disabled={pending}
            className="min-h-11"
            data-slot="onboarding-set-up-again"
          >
            {t("onboarding.flow.welcome.setUpAgain")}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="onboarding-welcome-title" className="space-y-6">
      <StepHeading
        id="onboarding-welcome-title"
        title={t("onboarding.flow.welcome.title")}
        description={t("onboarding.flow.welcome.body")}
      />

      <p className="text-sm">{t("onboarding.flow.welcome.changeLater")}</p>

      {/* One-time medical-disclaimer acknowledgment; the full text stays
          reachable on the public privacy page. */}
      <div className="border-border/60 bg-muted/30 flex items-start gap-3 rounded-lg border p-4">
        <Checkbox
          id={disclaimerId}
          checked={acknowledged}
          onCheckedChange={(next) => setAcknowledged(next === true)}
          className="mt-0.5"
          data-slot="onboarding-disclaimer"
        />
        <label
          htmlFor={disclaimerId}
          className="text-foreground text-sm leading-relaxed"
        >
          {t("onboarding.disclaimer.acknowledge")}{" "}
          <Link
            href="/privacy#medical-boundary"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4"
          >
            {t("onboarding.disclaimer.learnMore")}
          </Link>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={skipForNow}
          disabled={pending || !acknowledged}
          className="min-h-11"
          data-slot="onboarding-skip-for-now"
        >
          {t("onboarding.flow.welcome.skip")}
        </Button>
        <Button
          type="button"
          size="lg"
          onClick={setUp}
          disabled={pending || !acknowledged}
          className="min-h-11"
          data-slot="onboarding-set-up"
        >
          {t("onboarding.flow.welcome.setUp")}
        </Button>
      </div>
    </section>
  );
}
