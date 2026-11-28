"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { ImagingView } from "@/components/imaging/imaging-view";

/**
 * Imaging exams (#1672). With the `imaging` module off the navigation entry
 * is gone, and a deep link lands on the shell's module notice
 * (`ModulePageGate`, through `nav:/imaging` in the surface map) instead of
 * this page. The `/api/imaging*` routes stay reachable, so the gate is the
 * surface's, never the security boundary. An unauthenticated visitor is sent
 * to login.
 */
export default function ImagingPage() {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.push("/auth/login");
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !isAuthenticated) return <PageAuthGate />;
  return <ImagingView />;
}
