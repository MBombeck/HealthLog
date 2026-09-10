import { redirect } from "next/navigation";

import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { WelcomeScreen } from "@/components/onboarding/welcome-screen";
import { loadOnboardingFlowState } from "@/lib/onboarding/load-flow-state";
import { isOnboardingSettled } from "@/lib/onboarding/needs";
import { resumeScreen } from "@/lib/onboarding/wizard-steps";

/**
 * v1.39 (C2) — the setup flow's front door.
 *
 * The proxy lands every account still pending its first run here, and
 * Settings → "Set up again" does too. What is shown depends on where the
 * flow stands, read off the same ledger every screen reads:
 *
 *   - never entered            → the welcome screen ("Set up" / "Skip for now")
 *   - a step still owed        → redirect to that step
 *   - finished                 → the welcome screen's "again" variant, which
 *                                offers the questions once more or the dashboard
 *
 * No session mirrors the proxy's own gate (`/onboarding` is a public path,
 * so the page has to say it too).
 */
export default async function OnboardingRootPage() {
  const flow = await loadOnboardingFlowState();
  if (!flow) {
    redirect("/auth/login");
  }
  const { state, userLocale } = flow;

  const resume = resumeScreen(state);
  if (resume !== "welcome") {
    const finished = state.completedAt !== null && isOnboardingSettled(state);
    if (!finished) {
      redirect(`/onboarding/${resume}`);
    }
    return (
      <OnboardingShell screen="welcome" state={state} userLocale={userLocale}>
        <WelcomeScreen variant="again" />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell screen="welcome" state={state} userLocale={userLocale}>
      <WelcomeScreen variant="fresh" />
    </OnboardingShell>
  );
}
