import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { AiScreen } from "@/components/onboarding/ai-screen";
import { AreasScreen } from "@/components/onboarding/areas-screen";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { ProfileScreen } from "@/components/onboarding/profile-screen";
import { RemindersScreen } from "@/components/onboarding/reminders-screen";
import { SourcesScreen } from "@/components/onboarding/sources-screen";
import { UnitsScreen } from "@/components/onboarding/units-screen";
import { WhoScreen } from "@/components/onboarding/who-screen";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import { loadOnboardingFlowState } from "@/lib/onboarding/load-flow-state";
import {
  canVisitScreen,
  isPersonScreenId,
  PERSON_SCREEN_IDS,
  resumeScreen,
  segmentOf,
  type OnboardingScreenId,
} from "@/lib/onboarding/wizard-steps";

/**
 * One person setup screen per URL (1.50):
 *
 *   /onboarding/who        whose record, and the disclaimer
 *   /onboarding/areas      what to keep an eye on (the modules)
 *   /onboarding/units      name, time zone, units
 *   /onboarding/profile    the managed profile ("someone I look after", "both")
 *   /onboarding/sources    connect where readings come from
 *   /onboarding/reminders  where reminders arrive
 *   /onboarding/ai         the Coach, yes or no
 *
 * The URL is guarded by the step machine: going back is always allowed,
 * jumping ahead bounces to the screen the flow owes, and a screen this flow
 * does not contain bounces the same way. Everything lives under
 * `/onboarding/`, which is what the proxy's first-run redirect lets through.
 */
export const dynamicParams = false;

export function generateStaticParams() {
  return PERSON_SCREEN_IDS.map((step) => ({ step }));
}

interface PageProps {
  params: Promise<{ step: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { step } = await params;
  if (!isPersonScreenId(step)) return {};
  const flow = await loadOnboardingFlowState();
  if (!flow) return {};
  const locale = await resolveServerLocale({ userLocale: flow.userLocale });
  const { t } = getServerTranslator(locale);
  return { title: t(`setup.person.segments.${segmentOf(step)}`) };
}

export default async function OnboardingStepPage({ params }: PageProps) {
  const { step } = await params;
  if (!isPersonScreenId(step)) notFound();

  const flow = await loadOnboardingFlowState();
  if (!flow) redirect("/auth/login");
  const { state, userLocale, plan } = flow;
  const machine = { ...state, plan };

  if (!canVisitScreen(machine, step)) {
    const resume = resumeScreen(machine);
    redirect(resume ? `/onboarding/${resume}` : "/");
  }

  return (
    <OnboardingShell screen={step} state={machine} userLocale={userLocale}>
      {renderScreen(step, { state, plan })}
    </OnboardingShell>
  );
}

function renderScreen(
  screen: OnboardingScreenId,
  props: Parameters<typeof WhoScreen>[0],
) {
  switch (screen) {
    case "who":
      return <WhoScreen {...props} />;
    case "areas":
      return <AreasScreen {...props} />;
    case "units":
      return <UnitsScreen {...props} />;
    case "profile":
      return <ProfileScreen {...props} />;
    case "sources":
      return <SourcesScreen {...props} />;
    case "reminders":
      return <RemindersScreen {...props} />;
    case "ai":
      return <AiScreen {...props} />;
  }
}
