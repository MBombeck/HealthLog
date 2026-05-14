import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

/**
 * v1.4.25 W14b — onboarding root redirect.
 *
 * The proxy redirect (`src/proxy.ts:179`) lands every still-pending user
 * on `/onboarding`. Until W14b shipped, this file rendered the v1.4.20
 * single-file 3-step wizard inline. The new flow lives under
 * `/onboarding/[step]/page.tsx`, so this root page now resolves to a
 * server-side redirect into the right step:
 *
 *   - No session                  → `/auth/login` (the proxy enforces
 *     this too; we mirror it to keep the contract explicit).
 *   - `onboardingCompletedAt != null` (returning user)
 *                                 → `/onboarding/0` so the welcome-back
 *                                   banner can show; the dashboard is
 *                                   one click away from there.
 *   - Otherwise                   → `/onboarding/<current>` where
 *                                   `current = user.onboardingStep ?? 0`.
 *
 * The previous wizard remained the entry point through the
 * W14b-Foundation phase to keep an unbroken flow; this commit swaps it
 * out now that every step page renders real UI.
 */
export default async function OnboardingRootPage() {
  const session = await getSession();
  if (!session) {
    redirect("/auth/login");
  }
  const { user } = session;

  const current = clampCurrentStep(user.onboardingStep);
  redirect(`/onboarding/${current}`);
}

function clampCurrentStep(value: number | null | undefined): 0 | 1 | 2 | 3 | 4 {
  if (value == null || !Number.isFinite(value)) return 0;
  const floor = Math.floor(value);
  if (floor <= 0) return 0;
  if (floor >= 4) return 4;
  return floor as 0 | 1 | 2 | 3 | 4;
}
