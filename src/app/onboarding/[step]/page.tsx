import { redirect, notFound } from "next/navigation";

import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { getSession } from "@/lib/auth/session";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";

/**
 * v1.4.25 W14b — onboarding wizard step page (foundation scaffold).
 *
 * Routes:
 *   /onboarding/0  welcome    → carousel / value-prop intro
 *   /onboarding/1  goals      → "what do you want to track?"
 *   /onboarding/2  source     → Withings / Apple Health / manual cards
 *   /onboarding/3  baseline   → first measurement or sync confirmation
 *   /onboarding/4  done       → success screen + return to dashboard
 *
 * This page ships the scaffold only — the step body is a placeholder
 * `<div>` that the W14b-Content agent replaces with real step UI.
 *
 * Step gating:
 *   - Unauthenticated → `/auth/login` (the proxy also enforces this,
 *     but the server-side check keeps the contract explicit).
 *   - `onboardingCompletedAt != null` → `/` (no replaying the wizard
 *     by URL once the user has finished).
 *   - Out-of-order requests (e.g. user lands on `/onboarding/3` while
 *     `onboardingStep == 1`) redirect to the user's current step. The
 *     "current step" is `User.onboardingStep ?? 0`.
 *
 * The user MAY navigate backwards (e.g. `/onboarding/0` while on step
 * 2). Backwards navigation is non-destructive — the shell's "Back"
 * button uses it. Only forward jumps are blocked.
 */

const VALID_STEPS = [0, 1, 2, 3, 4] as const;
type Step = (typeof VALID_STEPS)[number];

export const dynamicParams = false;

export function generateStaticParams() {
  return VALID_STEPS.map((step) => ({ step: String(step) }));
}

interface PageProps {
  params: Promise<{ step: string }>;
}

export default async function OnboardingStepPage({ params }: PageProps) {
  const { step: stepParam } = await params;
  const parsedStep = Number.parseInt(stepParam, 10);

  if (!Number.isFinite(parsedStep) || !VALID_STEPS.includes(parsedStep as Step)) {
    notFound();
  }
  const requested = parsedStep as Step;

  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }
  const { user } = session;

  if (user.onboardingCompletedAt) {
    redirect("/");
  }

  const current = clampCurrentStep(user.onboardingStep);
  if (requested > current) {
    redirect(`/onboarding/${current}`);
  }

  const locale = await resolveServerLocale({ userLocale: user.locale });
  const { t } = getServerTranslator(locale);

  // Foundation scaffold body — placeholder per-step copy. The Content
  // agent replaces each branch's body with the real carousel /
  // goal-chips / source-cards / baseline-form / done-screen UI.
  //
  // Welcome copy lives under `onboarding.shell.welcome{Title,Body}`
  // because the carousel is part of the chrome; every other step
  // owns its own namespace (`onboarding.goals.*`, `.source.*`,
  // `.baseline.*`, `.done.*`).
  const bodyTitle =
    requested === 0
      ? t("onboarding.shell.welcomeTitle")
      : t(`onboarding.${stepKey(requested)}.title`);
  const bodyText =
    requested === 0
      ? t("onboarding.shell.welcomeBody")
      : t(`onboarding.${stepKey(requested)}.body`);

  // Wire shell navigation by step. Step 0 has no Back; the wizard
  // never lets the user navigate forward past their current step, but
  // they can advance from the current step's "Next" button — the
  // POST /api/onboarding/step mutation flips `onboardingStep` and the
  // Content agent will redirect to the new step on success. The
  // Foundation scaffold uses plain hrefs so the shell renders end-to-
  // end immediately; the Content agent will replace the next link
  // with an action button bound to the API.
  const backHref = requested > 0 ? `/onboarding/${requested - 1}` : undefined;
  const skipHref = requested > 0 && requested < 4 ? "/" : undefined;
  const nextHref =
    requested < 4 ? `/onboarding/${requested + 1}` : "/";

  return (
    <OnboardingShell
      step={requested}
      backHref={backHref}
      skipHref={skipHref}
      nextHref={nextHref}
      userLocale={user.locale ?? null}
    >
      <section className="space-y-4" aria-labelledby="onboarding-step-title">
        <h1
          id="onboarding-step-title"
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight"
        >
          {bodyTitle}
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed">
          {bodyText}
        </p>
        <div
          data-testid="onboarding-step-body"
          aria-label="Step body placeholder — W14b-Content agent fills in real UI."
          className="bg-muted/30 min-h-[140px] rounded-lg border border-dashed p-6"
        />
      </section>
    </OnboardingShell>
  );
}

function clampCurrentStep(value: number | null | undefined): Step {
  if (value == null || !Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  if (floor <= 0) return 0;
  if (floor >= 4) return 4;
  return floor as Step;
}

function stepKey(step: Step): "welcome" | "goals" | "source" | "baseline" | "done" {
  switch (step) {
    case 0:
      return "welcome";
    case 1:
      return "goals";
    case 2:
      return "source";
    case 3:
      return "baseline";
    case 4:
      return "done";
  }
}
