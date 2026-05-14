"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.25 W14b-Content — onboarding step 4 (done).
 *
 * Confirms the user has finished onboarding. `onboardingCompletedAt`
 * was flipped server-side by the baseline form's `POST step:4` write,
 * so this page is purely presentational — no further mutation, no
 * cookie flips, no API calls.
 *
 * The single CTA returns the user to the dashboard. The link goes
 * through `next/link` so the regular client-side navigation kicks in
 * (the proxy redirect was cleared with the same step-API write that
 * landed the user here).
 */

export function DoneScreen() {
  const { t } = useTranslations();

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

      <header className="space-y-2">
        <h1
          id="onboarding-done-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {t("onboarding.done.title")}
        </h1>
        <p className="text-muted-foreground mx-auto max-w-md text-base leading-relaxed">
          {t("onboarding.done.body")}
        </p>
      </header>

      <Button asChild size="lg">
        <Link href="/">{t("onboarding.done.returnCta")}</Link>
      </Button>
    </section>
  );
}
