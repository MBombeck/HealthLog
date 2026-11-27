import { redirect } from "next/navigation";

import { hasPendingHandoverDecision } from "@/lib/managed-profiles/handover";
import { loadOnboardingFlowState } from "@/lib/onboarding/load-flow-state";
import { resumeScreen } from "@/lib/onboarding/wizard-steps";

/**
 * The setup flow's front door (1.50). The proxy lands every account still
 * pending its first run here; it holds no screen of its own and sends the
 * person to where they stand:
 *
 *   - an admin whose server setup is open (and not set aside): that first
 *   - a step still owed: that step (a fresh account starts on "who")
 *   - nothing owed: the dashboard
 *
 * No session mirrors the proxy's own gate (`/onboarding` is a public path,
 * so the page has to say it too).
 */
export const dynamic = "force-dynamic";

export default async function OnboardingRootPage(props?: {
  searchParams?: Promise<{ handover?: string | string[] }>;
}) {
  const flow = await loadOnboardingFlowState();
  if (!flow) redirect("/auth/login");

  // v1.42 (#959) — an account that just claimed a managed profile decides its
  // former Guardians' access first. `?handover=later` is that screen's own
  // "later", which must not bounce straight back to it; the decision then
  // waits in Settings › Shared access.
  const handover = (await props?.searchParams)?.handover;
  if (handover !== "later" && (await hasPendingHandoverDecision(flow.userId))) {
    redirect("/onboarding/handover");
  }

  if (flow.serverSetupOpen) redirect("/onboarding/server");

  const resume = resumeScreen({ ...flow.state, plan: flow.plan });
  redirect(resume ? `/onboarding/${resume}` : "/");
}
