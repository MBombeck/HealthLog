import { redirect, notFound } from "next/navigation";

import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { WelcomeCarousel } from "@/components/onboarding/WelcomeCarousel";
import { GoalsChipPicker } from "@/components/onboarding/GoalsChipPicker";
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

  // Welcome (step 0) renders the client-side value-prop carousel.
  // The carousel owns its own primary CTA (POST /api/onboarding/step
  // with step:1) so the shell drops `nextHref` to avoid a double CTA.
  if (requested === 0) {
    return (
      <OnboardingShell step={0} userLocale={user.locale ?? null}>
        <WelcomeCarousel />
      </OnboardingShell>
    );
  }

  // Goals (step 1) — multi-select chip grid. Component owns its own
  // Back/Skip/Next row so the shell drops every footer href to avoid
  // duplicate controls. The user id is threaded as a prop so the
  // client hydration reads localStorage synchronously in its state
  // initializer (avoids the setState-in-effect anti-pattern).
  if (requested === 1) {
    return (
      <OnboardingShell step={1} userLocale={user.locale ?? null}>
        <GoalsChipPicker userId={user.id} />
      </OnboardingShell>
    );
  }

  // Foundation placeholder branches — replaced one step at a time by
  // the W14b-Content agent. Each step's body resolves to the real i18n
  // copy already, so the page reads end-to-end even before the per-
  // step component lands.
  const bodyTitle = t(`onboarding.${stepKey(requested)}.title`);
  const bodyText = t(`onboarding.${stepKey(requested)}.body`);

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
