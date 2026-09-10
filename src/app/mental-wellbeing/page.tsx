"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { MentalWellbeing } from "@/components/mental-health/mental-wellbeing";

/**
 * `/mental-wellbeing` — standalone module page (moved off `/insights/*` in
 * v1.25.1 so it no longer borrows the Insights tab strip / layout shell).
 *
 * Opt-in PHQ-9 / GAD-7 screener surface, beside mood tracking. The screen owns
 * its own questionnaire + result + crisis-resource flow; it deliberately does
 * NOT mount the shared Coach-launch assessment card (mental-health item content
 * is kept out of the AI Coach by construction).
 *
 * Born-gated on the resolved `modules.mentalHealth` flag from `GET /api/auth/me`
 * (opt-in / default-off — the per-user opt-in AND the operator server-wide
 * kill-switch). An unauthenticated visitor is bounced to login; an authenticated
 * account without the module opted in is bounced home (the nav entry is already
 * hidden for them, so this only catches a direct URL hit). Both assessment
 * routes also enforce the gate server-side, so this is a UX redirect, not the
 * security boundary.
 */
export default function MentalWellbeingPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  const enabled = user?.modules?.mentalHealth === true;

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.push("/auth/login");
    } else if (!enabled) {
      router.push("/");
    }
  }, [isLoading, isAuthenticated, enabled, router]);

  if (isLoading || !isAuthenticated || !enabled) {
    return <PageAuthGate />;
  }

  return (
    <div className="p-4 sm:p-6">
      <MentalWellbeing />
    </div>
  );
}
