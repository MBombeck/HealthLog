import { redirect, notFound } from "next/navigation";
import Link from "next/link";

import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { WelcomeCarousel } from "@/components/onboarding/WelcomeCarousel";
import { GoalsChipPicker } from "@/components/onboarding/GoalsChipPicker";
import { SourceCardGrid } from "@/components/onboarding/SourceCardGrid";
import { BaselineForm } from "@/components/onboarding/BaselineForm";
import { DoneScreen } from "@/components/onboarding/DoneScreen";
import { Button } from "@/components/ui/button";
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

  const completed = user.onboardingCompletedAt != null;

  // Completed users hitting any mid-flow step (1, 2, 3) are bounced
  // back to the dashboard — replaying half the wizard is never useful.
  // Step 0 stays accessible as the welcome-back surface (banner instead
  // of carousel) and step 4 stays accessible as the success screen so
  // a re-landing user has a clean "Open dashboard" exit.
  if (completed && requested > 0 && requested < 4) {
    redirect("/");
  }

  const current = clampCurrentStep(user.onboardingStep);
  if (!completed && requested > current) {
    redirect(`/onboarding/${current}`);
  }

  const locale = await resolveServerLocale({ userLocale: user.locale });
  const { t } = getServerTranslator(locale);

  // Welcome (step 0)
  //   * Fresh user → value-prop carousel.
  //   * Returning user (onboarding already completed) → welcome-back
  //     banner with "Open dashboard" CTA. Marc note 2026-05-14: the
  //     "restart onboarding" affordance lives in Settings → Account in
  //     v1.4.26; for now the banner is informational only.
  if (requested === 0) {
    return (
      <OnboardingShell step={0} userLocale={user.locale ?? null}>
        {completed ? (
          <section
            aria-labelledby="onboarding-welcomeback-title"
            className="space-y-5"
          >
            <h1
              id="onboarding-welcomeback-title"
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight"
            >
              {t("onboarding.welcomeBack.title")}
            </h1>
            <p className="text-muted-foreground text-base leading-relaxed">
              {t("onboarding.welcomeBack.body")}
            </p>
            <div className="flex justify-end">
              <Button asChild size="lg">
                <Link href="/">{t("onboarding.welcomeBack.cta")}</Link>
              </Button>
            </div>
          </section>
        ) : (
          <WelcomeCarousel />
        )}
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

  // Source (step 2) — four-card grid. Manual is the implicit default;
  // Withings opens OAuth in a new tab; Apple Health is rendered as a
  // "coming with v1.5" announce card; Garmin is omitted per the
  // W14b-Content brief (not on the roadmap yet).
  if (requested === 2) {
    return (
      <OnboardingShell step={2} userLocale={user.locale ?? null}>
        <SourceCardGrid />
      </OnboardingShell>
    );
  }

  // Baseline (step 3) — profile form. PUT /api/auth/profile saves the
  // four fields, then POST step:4 advances + flips
  // `onboardingCompletedAt`.
  if (requested === 3) {
    return (
      <OnboardingShell step={3} userLocale={user.locale ?? null}>
        <BaselineForm />
      </OnboardingShell>
    );
  }

  // Done (step 4) — success screen + dashboard CTA. Reachable both
  // after first-completion (POST step:4) and again if a completed
  // user lands here by URL.
  return (
    <OnboardingShell step={4} userLocale={user.locale ?? null}>
      <DoneScreen />
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
