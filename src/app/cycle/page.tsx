"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { CycleView } from "@/components/cycle/cycle-view";

/**
 * v1.15.0 — the cycle vertical entry.
 *
 * Gated on the resolved `modules.cycle` flag from `GET /api/auth/me`
 * (v1.18.0 — the per-user toggle AND the operator server-wide kill-switch;
 * the operator-unaware `cycleTrackingEnabled` field is NOT used here so an
 * operator-disabled instance bounces a direct URL hit too). An
 * unauthenticated visitor is bounced to login; an authenticated account
 * without the module enabled is bounced home (the nav entry is already
 * hidden for them, so this only catches a direct URL hit). Every
 * `/api/cycle/*` route also enforces the gate server-side, so this is a UX
 * redirect, not the security boundary.
 */
export default function CyclePage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  const enabled = user?.modules?.cycle !== false;

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

  // `<CycleView>` reads `useSearchParams` for the `?tab=` deep-link; wrap it in
  // a Suspense boundary so the client-search-params bailout never de-opts the
  // build (Next's `missing-suspense-with-csr-bailout`).
  return (
    <Suspense fallback={<PageAuthGate />}>
      <CycleView />
    </Suspense>
  );
}
