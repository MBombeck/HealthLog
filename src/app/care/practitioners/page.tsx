"use client";

import { PageAuthGate } from "@/components/ui/page-auth-gate";
import { PractitionerList } from "@/components/practitioners/practitioner-list";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";

/**
 * The address book, one level under the checkups page the visits live on.
 *
 * Deliberately not in Settings. The Settings IA rule is that a settings surface
 * configures behaviour; a list of one's own doctors configures nothing and is
 * record content like every other clinical list. Sitting under `/care`
 * also means it inherits that page's route-family classification, so a
 * `profile`-scoped delegate reaches it exactly as they reach the visits.
 */
export default function PractitionersPage() {
  const { isAuthenticated, isLoading } = useAuth();
  const mounted = useMounted();

  if (!mounted || isLoading) return <PageAuthGate />;

  return (
    <div className="space-y-6">
      <PractitionerList enabled={isAuthenticated} />
    </div>
  );
}
