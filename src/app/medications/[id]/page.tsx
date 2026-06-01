"use client";

/**
 * v1.7.2 W3 — medication detail page as the history view.
 *
 * Supersedes the v1.5.6 composition that carried an Edit / History /
 * Advanced action row and a "Rhythmus" cadence block. Editing and
 * advanced settings are now reached from the medications-list card kebab
 * only; the detail page is purely history-centric:
 *
 *   back link → compact, NON-editable header (name / dose / status +
 *   plain-language cadence line) → intake-history table → GLP-1
 *   drug-level / titration as a default-CLOSED disclosure.
 *
 * The side-effect logbook stays inline for GLP-1 medications (genuine
 * history context). CSV import rides the intake-history section header.
 *
 * Reads:
 *
 *   - `medicationDetail(id)` for the medication snapshot.
 *   - `medicationIntakeList(id, …)` for the header total.
 *
 * Mutations all cascade through `medicationDependentKeys`.
 */

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DrugLevelChart } from "@/components/medications/DrugLevelChart";
import { TitrationSection } from "@/components/medications/TitrationSection";
import { MedicationDetailSummary } from "@/components/medications/medication-detail-summary";
import { IntakeHistoryPreview } from "@/components/medications/sections/intake-history-preview";
import { SideEffectsSection } from "@/components/medications/SideEffectsSection";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";

interface ScheduleSnapshot {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  reminderGraceMinutes?: number | null;
}

interface MedicationDetailSnapshot {
  id: string;
  name: string;
  dose: string;
  category: string;
  treatmentClass?: string;
  deliveryForm?: string;
  dosesPerUnit?: number | null;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  oneShot?: boolean;
  schedules: ScheduleSnapshot[];
}

function snapshotToWizardPayload(
  med: MedicationDetailSnapshot,
): MedicationPayload {
  return {
    id: med.id,
    name: med.name,
    dose: med.dose,
    category: med.category,
    treatmentClass: med.treatmentClass,
    deliveryForm: med.deliveryForm,
    dosesPerUnit: med.dosesPerUnit ?? null,
    notificationsEnabled: med.notificationsEnabled,
    startsOn: med.startsOn ? new Date(med.startsOn) : null,
    endsOn: med.endsOn ? new Date(med.endsOn) : null,
    oneShot: med.oneShot ?? false,
    schedules: med.schedules.map((s) => ({
      id: s.id,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
      label: s.label ?? null,
      dose: s.dose ?? null,
      ...parseScheduleRecurrence(s.daysOfWeek),
      timesOfDay: s.timesOfDay,
      rrule: s.rrule ?? null,
      rollingIntervalDays: s.rollingIntervalDays ?? null,
    })),
  };
}

export default function MedicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const { t } = useTranslations();

  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push("/auth/login");
    }
  }, [authLoading, isAuthenticated, router]);

  const {
    data: medication,
    isLoading,
    isError,
  } = useQuery<MedicationDetailSnapshot>({
    queryKey: queryKeys.medicationDetail(id),
    queryFn: async () => {
      const res = await fetch(`/api/medications/${id}`);
      if (!res.ok) throw new Error("medication_detail_failed");
      return (await res.json()).data as MedicationDetailSnapshot;
    },
    enabled: isAuthenticated,
  });

  // v1.7.2 W3 — derive the wizard payload purely to feed the read-only
  // cadence summary line (the editor itself lives on the card kebab).
  const wizardPayload = useMemo<MedicationPayload | null>(
    () => (medication ? snapshotToWizardPayload(medication) : null),
    [medication],
  );

  if (authLoading || isLoading) {
    return (
      <div
        className="flex h-64 items-center justify-center"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          aria-hidden="true"
          className="text-primary h-8 w-8 animate-spin motion-reduce:animate-none"
        />
      </div>
    );
  }

  if (isError || !medication) {
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
        <Card
          className="p-6"
          role="alert"
          aria-live="polite"
          data-slot="medication-detail-error-card"
        >
          <p className="text-destructive text-sm">
            {t("medications.loadFailed")}
          </p>
        </Card>
      </div>
    );
  }

  const oneShot = medication.oneShot === true;
  // `wizardPayload` is non-null here — the early returns above bail
  // before this point whenever `medication` is undefined.
  const payload = wizardPayload as MedicationPayload;
  const isGlp1 = !oneShot && medication.treatmentClass === "GLP1";

  return (
    <div className="space-y-6" data-slot="medication-detail-page">
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 gap-1"
        asChild
      >
        <Link href="/medications">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          {t("medications.back")}
        </Link>
      </Button>

      {/* v1.7.2 W3 — compact, NON-editable header. Editing and advanced
          settings are reached from the medications-list card kebab only;
          the detail page is history-centric. The header is a read-only
          summary: name / dose / status + plain-language cadence line. */}
      <MedicationDetailSummary
        name={medication.name}
        dose={medication.dose}
        active={medication.active}
        endsOn={medication.endsOn}
        payload={payload}
        oneShot={oneShot}
        startsOn={medication.startsOn}
      />

      {/* Intake history table — the primary surface. */}
      <IntakeHistoryPreview
        medicationId={id}
        importOpen={importOpen}
        onImportOpenChange={setImportOpen}
      />

      {/* v1.6.0 — side-effect logbook stays inline for GLP-1 medications
          (genuine history context). */}
      {isGlp1 && <SideEffectsSection medicationId={id} />}

      {/* GLP-1 drug-level curve + titration ladder as a default-CLOSED
          disclosure — genuine history context, opt-in so the intake
          table stays the dominant surface. The chart gates further on
          Research Mode. */}
      {isGlp1 && (
        <details
          className="border-border/60 rounded-md border"
          data-slot="detail-drug-level-disclosure"
        >
          <summary className="text-foreground flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium select-none sm:min-h-9">
            {t("medications.detail.history.drugLevelDisclosure")}
          </summary>
          <div className="border-border/60 space-y-6 border-t px-3 py-3">
            <DrugLevelChart
              medication={{
                id: medication.id,
                name: medication.name,
                dose: medication.dose,
              }}
            />
            <TitrationSection medicationId={id} />
          </div>
        </details>
      )}
    </div>
  );
}
