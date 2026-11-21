"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { EmergencyCardPage } from "@/components/emergency-card/emergency-card-page";
import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { useAuth } from "@/hooks/use-auth";

/**
 * The emergency card for when you are away from home: the card, its
 * offline copy and wallet card, and the read-only QR link. Always the signed-in
 * person's own card; the routes behind it serve the caller's own record.
 */
export default function EmergencyCardRoute() {
  const { isLoading, isAuthenticated } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.push("/auth/login");
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !isAuthenticated) return <PageAuthGate />;
  return <EmergencyCardPage />;
}
