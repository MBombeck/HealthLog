"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { SeizuresView } from "@/components/seizures/seizures-view";

/**
 * The seizure diary (#1368).
 *
 * Gated on the resolved `modules.seizures` flag from `GET /api/auth/me`. The
 * module is opt-in, so only an explicit `true` opens the page. A direct visit
 * with the module off meets the shared module gate's notice before this page
 * mounts; the redirect below is the fallback for a flag that changes while
 * the page is open.
 * The map is the RECORD's, masked to what the grant opens, so a guardian in a
 * managed child's record is answered about the child's diary. The
 * `/api/seizures*` routes refuse on their own; this is a UX redirect, never
 * the security boundary.
 */
export default function SeizuresPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const enabled = user?.modules?.seizures === true;

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

  return <SeizuresView />;
}
