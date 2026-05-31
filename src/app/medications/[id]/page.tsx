"use client";

/**
 * v1.5.6 G-1 — medication detail page as a pure history surface.
 *
 * Supersedes the v1.5.5 composition that stacked every setting inline.
 * The page now reads as a calm "Vergangenheit" view: back link → slim
 * header (name / dose / status + a two-option Bearbeiten dropdown) →
 * STATIC cadence line → GLP-1 dose-ladder read-only visualisation →
 * intake-history table. Every setting — Notifications, API tokens,
 * Phasen, CSV import, grace and the destructive zone — moves into the
 * `<AdvancedSettingsSheet>`, reached from the dropdown's "Erweiterte
 * Einstellungen" item. "Plan bearbeiten" opens the wizard at Step 1.
 *
 * One-shot variant drops the dose-ladder section and renders the
 * static `Einmalig am …` line in place of the cadence summary.
 *
 * Reads:
 *
 *   - `medicationDetail(id)` for the medication snapshot.
 *   - `medicationIntakeList(id, …)` for `intakeCount`, which the
 *     sheet's destructive zone needs.
 *
 * Mutations all cascade through `medicationDependentKeys` (which
 * includes the `compliance-chart-inline` prefix per D-3 §10).
 */

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DrugLevelChart } from "@/components/medications/DrugLevelChart";
import { TitrationSection } from "@/components/medications/TitrationSection";
import { MedicationDetailHeader } from "@/components/medications/medication-detail-header";
import { CadenceSummaryRow } from "@/components/medications/cadence-summary-row";
import { IntakeHistoryPreview } from "@/components/medications/sections/intake-history-preview";
import { SideEffectsSection } from "@/components/medications/SideEffectsSection";
import { SchedulingSection } from "@/components/medications/SchedulingSection";
import { AdvancedSettingsSheet } from "@/components/medications/advanced-settings-sheet";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import { MedicationWizardDialog } from "@/components/medications/wizard/MedicationWizardDialog";
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

interface IntakeListResponse {
  events: Array<{
    id: string;
    scheduledFor: string;
    takenAt: string | null;
    skipped: boolean;
  }>;
  meta: { total: number; limit: number; offset: number };
}

const INTAKE_PREVIEW_PARAMS = {
  sortBy: "takenAt",
  sortDir: "desc" as const,
  limit: 14,
  offset: 0,
  status: "completed",
};

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
  const formatters = useFormatters();

  const [wizardOpen, setWizardOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);
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

  const { data: intakeList } = useQuery<IntakeListResponse>({
    queryKey: queryKeys.medicationIntakeList(id, INTAKE_PREVIEW_PARAMS),
    queryFn: async () => {
      const params = new URLSearchParams({
        sortBy: INTAKE_PREVIEW_PARAMS.sortBy,
        sortDir: INTAKE_PREVIEW_PARAMS.sortDir,
        limit: String(INTAKE_PREVIEW_PARAMS.limit),
        offset: String(INTAKE_PREVIEW_PARAMS.offset),
        status: INTAKE_PREVIEW_PARAMS.status,
      });
      const res = await fetch(
        `/api/medications/${id}/intake?${params.toString()}`,
      );
      if (!res.ok) throw new Error("intake_list_failed");
      return (await res.json()).data as IntakeListResponse;
    },
    enabled: isAuthenticated && !!medication,
  });

  // v1.5.6 F-1 M-2 — memoise the wizard payload so the header dropdown
  // + wizard mount share one object identity per medication snapshot
  // instead of recomputing it on every render.
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
  const intakeCount = intakeList?.meta.total ?? 0;
  const primaryGrace = medication.schedules[0]?.reminderGraceMinutes ?? null;
  // `wizardPayload` is non-null here — the early returns above bail
  // before this point whenever `medication` is undefined.
  const payload = wizardPayload as MedicationPayload;

  // v1.5.6 G-1 §5 — sibling-swap: close the advanced sheet first, then
  // open the phase sheet so the two never stack (modal depth ≤ 2).
  function openPhaseSheet() {
    setAdvancedOpen(false);
    setPhaseSheetOpen(true);
  }

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

      {/* v1.7.0 — Header band. Three buttons: Edit opens the wizard,
          History routes directly to the full intake-history view, and
          Advanced opens the settings sheet. The page owns the wizard +
          advanced open-states; History is a plain navigation. */}
      <MedicationDetailHeader
        name={medication.name}
        dose={medication.dose}
        active={medication.active}
        endsOn={medication.endsOn}
        onEditPlan={() => setWizardOpen(true)}
        onOpenHistory={() => router.push(`/medications/${id}/history`)}
        onOpenAdvanced={() => setAdvancedOpen(true)}
      />

      {/* G-1 §3.3 — Cadence line. One-shot collapses to the
          `Einmalig am …` card; recurring renders the summary row whose
          edit affordance opens the editor directly. */}
      {oneShot ? (
        <Card
          className="p-5 sm:p-6"
          data-slot="medication-detail-one-shot-cadence"
        >
          <p className="text-foreground text-sm">
            {medication.startsOn
              ? t("medications.detail.cadence.oneShotOn", {
                  date: formatters.dateTime(medication.startsOn),
                })
              : t("medications.detail.cadence.oneShotPending")}
          </p>
        </Card>
      ) : (
        <CadenceSummaryRow
          medication={payload}
          onEdit={() => setWizardOpen(true)}
        />
      )}

      {/* G-1 §3.4 — Dose ladder / Phasen visualisation (read-only,
          GLP-1 recurring only). The editor lives in the sheet. */}
      {!oneShot && medication.treatmentClass === "GLP1" && (
        <>
          <DrugLevelChart
            medication={{
              id: medication.id,
              name: medication.name,
              dose: medication.dose,
            }}
          />
          {/* v1.6.0 — side-effect logbook + cadence/compliance section
              restored onto the detail page (they previously lived only
              on the legacy `/history` route). */}
          <SideEffectsSection medicationId={id} />
          <SchedulingSection
            medicationId={id}
            reminderEnabled={medication.notificationsEnabled}
          />
          <TitrationSection medicationId={id} />
        </>
      )}

      {/* G-1 §3.5 — Intake history table (primary surface). */}
      <IntakeHistoryPreview
        medicationId={id}
        importOpen={importOpen}
        onImportOpenChange={setImportOpen}
      />

      {/* G-1 §5 — Advanced settings sheet. Hosts Notifications →
          Settings → destructive zone. The Phasen button sibling-swaps
          to the phase sheet below. */}
      <AdvancedSettingsSheet
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        medicationId={id}
        medicationName={medication.name}
        treatmentClass={medication.treatmentClass}
        active={medication.active}
        startsOn={medication.startsOn}
        endsOn={medication.endsOn}
        notificationsEnabled={medication.notificationsEnabled}
        reminderGraceMinutes={primaryGrace}
        intakeCount={intakeCount}
        onRequestPhaseSheet={openPhaseSheet}
        onOpenImport={() => setImportOpen(true)}
      />

      {/* G-1 §5 — phase sheet mounted as a sibling of the advanced
          sheet so they never stack (GLP-1 + course window only). */}
      {!oneShot &&
        medication.treatmentClass === "GLP1" &&
        Boolean(medication.startsOn) &&
        Boolean(medication.endsOn) && (
          <PhaseConfigSheet
            medicationId={id}
            open={phaseSheetOpen}
            onOpenChange={setPhaseSheetOpen}
          />
        )}

      {/* Wizard mount — edit-only, lands on Step 1 (no landing
          intent). Cancel + success both close via the cascade. */}
      <MedicationWizardDialog
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        mode="edit"
        initial={payload}
        onSuccess={() => setWizardOpen(false)}
      />
    </div>
  );
}
