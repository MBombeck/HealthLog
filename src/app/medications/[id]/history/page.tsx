"use client";

import { useEffect, use } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DrugLevelChart } from "@/components/medications/DrugLevelChart";
import { SideEffectsSection } from "@/components/medications/SideEffectsSection";
import { SchedulingSection } from "@/components/medications/SchedulingSection";
import { TitrationSection } from "@/components/medications/TitrationSection";
import { ArrowLeft, Loader2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "@/lib/i18n/context";

export default function IntakeHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { t } = useTranslations();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [authLoading, isAuthenticated, router]);

  const { data: medication, isLoading: medLoading } = useQuery({
    queryKey: ["medications", id],
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        id: string;
        name: string;
        dose: string;
        treatmentClass?: string;
        notificationsEnabled?: boolean;
      };
    },
    enabled: isAuthenticated,
  });

  if (authLoading || medLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  // D-H8 — bump the sibling-section stride from `space-y-4` (16 px)
  // to `space-y-6` (24 px) so the medication-detail page matches the
  // `/insights/*` sub-page stride. The earlier 16 px gap rode tight
  // against each section's 1 px border (~14 px optical gap) and read
  // dense after the heading collapse landed in the canonical
  // `<MedicationDetailSection>`.
  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 gap-1"
        asChild
      >
        <Link href="/medications">
          <ArrowLeft className="h-4 w-4" />
          {t("medications.back")}
        </Link>
      </Button>

      {medication && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              {medication.name}
            </h1>
            <p className="text-muted-foreground hidden text-sm sm:block">
              {medication.dose}
            </p>
          </div>
        </div>
      )}

      {/* v1.4.25 W19c-Frontend — Research-mode-gated drug-level chart.
          Renders only for GLP-1 medications; the component itself
          gates further on Research Mode + version-aligned
          acknowledgment, so this page can mount it unconditionally
          for any GLP-1 row and trust the chart's internal logic. */}
      {medication?.treatmentClass === "GLP1" && (
        <DrugLevelChart
          medication={{
            id: medication.id,
            name: medication.name,
            dose: medication.dose,
          }}
        />
      )}

      {/* v1.4.25 W19d — GLP-1 side-effect logbook. Sits between the
          drug-level chart and the intake history so the user lands on
          the cycle context (where am I in the curve), then on the
          symptom record, then on the dose-by-dose timeline. Mounted
          only for GLP-1 medications; future waves (W19e reminders,
          W19f titration ladder) hang off this same surface. */}
      {medication?.treatmentClass === "GLP1" && (
        <SideEffectsSection medicationId={id} />
      )}

      {/* v1.4.25 W19e — GLP-1 cadence visualisation + compliance chips.
          Sits between the side-effect logbook and the intake history so
          the user lands on cycle context (drug-level), then symptom
          record, then schedule cadence + adherence, then the
          dose-by-dose timeline. */}
      {medication?.treatmentClass === "GLP1" && (
        <SchedulingSection
          medicationId={id}
          reminderEnabled={medication.notificationsEnabled ?? true}
        />
      )}

      {/* v1.4.25 W19f — GLP-1 titration-ladder display. Read-only EMA
          reference visual showing the standard dose-escalation schedule
          with the user's current step highlighted. Sits between
          SchedulingSection and the bottom of the page; v1.4.28 retired
          the IntakeHistoryList block that used to anchor the per-dose
          timeline below this section. */}
      {medication?.treatmentClass === "GLP1" && (
        <TitrationSection medicationId={id} />
      )}
    </div>
  );
}
