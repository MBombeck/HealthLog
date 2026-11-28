"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { ImagingView } from "@/components/imaging/imaging-view";

/**
 * Imaging exams (#1672). Gated on the resolved `modules.imaging` flag from
 * `GET /api/auth/me`: default-on, so only an explicit `false` hides it. A
 * direct hit with the module off goes home; the `/api/imaging*` routes stay
 * reachable, so this is a UX redirect, never the security boundary.
 */
export default function ImagingPage() {
  const { user, isLoading, isAuthenticated } = useAuth();
  const router = useRouter();
  const enabled = user?.modules?.imaging !== false;

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) router.push("/auth/login");
    else if (!enabled) router.push("/");
  }, [isLoading, isAuthenticated, enabled, router]);

  if (isLoading || !isAuthenticated || !enabled) return <PageAuthGate />;
  return <ImagingView />;
}
