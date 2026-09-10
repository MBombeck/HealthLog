"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { VaccinationsView } from "@/components/vaccinations/vaccinations-view";

/**
 * v1.37.3: the immunization log entry.
 *
 * Gated on the resolved `modules.vaccinations` flag from `GET /api/auth/me`.
 * The module is default-on, so `=== false` is the only state that hides the
 * surface — an account that never touched the toggle keeps it. An
 * unauthenticated visitor is bounced to login; an authenticated account that
 * turned the module off is bounced home (the nav entry is already gone for
 * them, so this only catches a direct URL hit). The `/api/vaccinations*`
 * routes stay reachable regardless — the module gate governs the surface, not
 * the row store — so this is a UX redirect, never the security boundary.
 */
export default function VaccinationsPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  // Default-on: hidden only when the resolved map says `false` explicitly.
  // The map is the RECORD's, masked to what the grant opens, so a delegate is
  // answered about the record they are in rather than about their own — and a
  // module the owner has switched off closes this page for them too.
  const enabled = user?.modules?.vaccinations !== false;

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

  return <VaccinationsView />;
}
