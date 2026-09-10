import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { ConfirmScreen } from "@/components/onboarding/confirm-screen";
import { FirstResultScreen } from "@/components/onboarding/first-result-screen";
import { QuestionScreen } from "@/components/onboarding/question-screen";
import { UnitsScreen } from "@/components/onboarding/units-screen";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { loadOnboardingFlowState } from "@/lib/onboarding/load-flow-state";
import {
  ONBOARDING_STEP_IDS,
  type OnboardingStateDto,
  type OnboardingStepId,
} from "@/lib/onboarding/needs";
import { isQuestionStepId } from "@/lib/onboarding/question-config";
import {
  canVisitScreen,
  resumeScreen,
  stepCounter,
} from "@/lib/onboarding/wizard-steps";

/**
 * v1.39 (C2) — one setup screen per step id.
 *
 *   /onboarding/who … /onboarding/visit   the five questions
 *   /onboarding/units                     Q6, when it applies
 *   /onboarding/confirm                   the module map and the profile
 *   /onboarding/first-result              the one task the flow ends on
 *   /onboarding/done                      the exit
 *
 * The URL is guarded by the step machine: going back is always allowed,
 * jumping ahead bounces to the screen the flow actually owes, and a screen
 * this flow does not contain (units for someone with no unit-bearing area)
 * bounces the same way. Everything lives under `/onboarding/`, which is what
 * the proxy's first-run redirect lets through — a segment outside it would
 * loop.
 *
 * Server component: the state is loaded once per request (`cache`), the
 * screens that hold a selection are the client parts.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return ONBOARDING_STEP_IDS.map((step) => ({ step }));
}

interface PageProps {
  params: Promise<{ step: string }>;
}

function asStepId(value: string): OnboardingStepId | null {
  return (ONBOARDING_STEP_IDS as readonly string[]).includes(value)
    ? (value as OnboardingStepId)
    : null;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { step } = await params;
  const screen = asStepId(step);
  const flow = screen ? await loadOnboardingFlowState() : null;
  if (!screen || !flow) return {};
  const locale = await resolveServerLocale({ userLocale: flow.userLocale });
  const { t } = getServerTranslator(locale);
  const counter = stepCounter(flow.state, screen);
  const name = t(`onboarding.steps.${screen}`);
  return {
    title: counter ? `${t("onboarding.shell.stepOf", counter)}: ${name}` : name,
  };
}

export default async function OnboardingStepPage({ params }: PageProps) {
  const { step } = await params;
  const screen = asStepId(step);
  if (!screen) notFound();

  const flow = await loadOnboardingFlowState();
  if (!flow) redirect("/auth/login");
  const { state, userLocale } = flow;

  if (!canVisitScreen(state, screen)) {
    const resume = resumeScreen(state);
    redirect(resume === "welcome" ? "/onboarding" : `/onboarding/${resume}`);
  }

  return (
    <OnboardingShell screen={screen} state={state} userLocale={userLocale}>
      {renderScreen(screen, state)}
    </OnboardingShell>
  );
}

function renderScreen(screen: OnboardingStepId, state: OnboardingStateDto) {
  if (isQuestionStepId(screen)) {
    return <QuestionScreen step={screen} state={state} />;
  }
  if (screen === "units") {
    return <UnitsScreen state={state} />;
  }
  if (screen === "confirm") {
    return <ConfirmScreen state={state} />;
  }
  if (screen === "first-result") {
    return <FirstResultScreen state={state} />;
  }
  notFound();
}
