"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { AdvancedSettingsSheet } from "@/components/medications/advanced-settings-sheet";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import { MedicationWizardDialog } from "@/components/medications/wizard/MedicationWizardDialog";
import type { MedicationPayload } from "@/components/medications/wizard/wizard-payload";
import { MedicationCard } from "@/components/medications/medication-card";
import { Glp1MedicationCard } from "@/components/medications/glp1-medication-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Loader2, Pill, Plus } from "lucide-react";

interface Schedule {
  id: string;
  windowStart: string;
  windowEnd: string;
  label: string | null;
  dose: string | null;
  daysOfWeek: string | null;
  /** v1.5 — first-class times-of-day. */
  timesOfDay?: string[];
  /** v1.5 — RFC 5545 RRULE string for calendar-anchored cadences. */
  rrule?: string | null;
  /** v1.5 — flexible-rolling interval in days. */
  rollingIntervalDays?: number | null;
  /** v1.5 — reminder grace window in minutes. */
  reminderGraceMinutes?: number | null;
}

interface Medication {
  id: string;
  name: string;
  dose: string;
  category: string;
  /** v1.4.25 W4d — Prisma treatment class (GENERIC | GLP1). */
  treatmentClass?: string;
  /** v1.4.25 W4d — doses per pen/vial for inventory math. */
  dosesPerUnit?: number | null;
  /** v1.6.0 — route of administration (ORAL | INJECTION | OTHER). */
  deliveryForm?: string;
  active: boolean;
  notificationsEnabled: boolean;
  pausedAt: string | null;
  lastTakenAt: string | null;
  /** v1.5 — medication-level course start date (ISO string). */
  startsOn?: string | null;
  /** v1.5 — medication-level course end date (ISO string). */
  endsOn?: string | null;
  /** v1.5 — single-administration medication. */
  oneShot?: boolean;
  schedules: Schedule[];
}

export default function MedicationsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { t } = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  // v1.5.4 — the retired `/medications/new` route redirects here with
  // `?new=1`, so legacy bookmarks keep landing on the create wizard.
  // The initial open state reads the query param synchronously so the
  // dialog opens on the very first render; a follow-up effect strips
  // the param from the URL so a manual close + refresh stays closed.
  const shouldOpenFromUrl = searchParams?.get("new") === "1";
  const [dialogOpen, setDialogOpen] = useState(shouldOpenFromUrl);
  const [editingMed, setEditingMed] = useState<Medication | null>(null);
  // v1.7.1 — the medications-card History + Advanced actions. History
  // navigates to the full intake-history view; Advanced opens one shared
  // `<AdvancedSettingsSheet>` mounted below, keyed to the selected
  // medication (reused, not duplicated per card).
  const [advancedMed, setAdvancedMed] = useState<Medication | null>(null);

  useEffect(() => {
    if (shouldOpenFromUrl) {
      // Drop the query param so a refresh after closing the dialog
      // doesn't keep reopening it.
      router.replace("/medications");
    }
  }, [shouldOpenFromUrl, router]);

  const {
    data: medications,
    isLoading,
    isError,
    refetch: refetchMedications,
  } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as Medication[];
    },
    enabled: isAuthenticated,
  });

  // v1.7.1 — the advanced sheet's danger zone needs `intakeCount` to
  // gate the purge button. Fetch it lazily once a medication is selected
  // (the list view never pays for it otherwise), mirroring the
  // detail-page query shape.
  const advancedIntakeParams = {
    sortBy: "takenAt",
    sortDir: "desc" as const,
    limit: 1,
    offset: 0,
    status: "completed",
  };
  const { data: advancedIntakeCount } = useQuery({
    queryKey: advancedMed
      ? queryKeys.medicationIntakeList(advancedMed.id, advancedIntakeParams)
      : ["medications", "intake-count", "none"],
    queryFn: async () => {
      if (!advancedMed) return 0;
      const params = new URLSearchParams({
        sortBy: advancedIntakeParams.sortBy,
        sortDir: advancedIntakeParams.sortDir,
        limit: String(advancedIntakeParams.limit),
        offset: String(advancedIntakeParams.offset),
        status: advancedIntakeParams.status,
      });
      const res = await fetch(
        `/api/medications/${advancedMed.id}/intake?${params.toString()}`,
      );
      if (!res.ok) return 0;
      const json = await res.json();
      return (json.data?.meta?.total ?? 0) as number;
    },
    enabled: isAuthenticated && !!advancedMed,
  });

  function openCreate() {
    setEditingMed(null);
    setDialogOpen(true);
  }

  function openEdit(med: Medication) {
    setEditingMed(med);
    setDialogOpen(true);
  }

  function openHistory(med: Medication) {
    router.push(`/medications/${med.id}/history`);
  }

  function openAdvanced(med: Medication) {
    setAdvancedMed(med);
  }

  function closeDialog() {
    setDialogOpen(false);
    setEditingMed(null);
  }

  if (authLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("medications.loginRequired")}
          </p>
        </div>
      </div>
    );
  }

  const byName = (a: Medication, b: Medication) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" });

  // Defensive against stale service-worker responses or any future API
  // shape change: only filter when we actually have an array.
  const medsArray = Array.isArray(medications) ? medications : [];
  const activeMeds = medsArray.filter((m) => m.active).sort(byName);
  const inactiveMeds = medsArray.filter((m) => !m.active).sort(byName);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {t("medications.title")}
          </h1>
          {/* v1.4.34 IW-G — subtitle stays visible on mobile so the
              H1 isn't an unframed label. */}
          <p className="text-muted-foreground text-xs sm:text-sm">
            {t("medications.subtitle")}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          {t("medications.addMedication")}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
        </div>
      ) : isError ? (
        <div className="bg-card border-border flex h-64 items-center justify-center rounded-xl border">
          <div className="flex flex-col items-center gap-3">
            <p className="text-muted-foreground text-sm">
              {t("medications.loadFailed")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetchMedications()}
            >
              {t("medications.retryLoad")}
            </Button>
          </div>
        </div>
      ) : !medications?.length ? (
        // v1.4.15 phase-C5: refactor the inline icon+text+button block
        // to the shared EmptyState primitive so the empty path matches
        // every other list page in the app (role=status, dashed
        // border, consistent icon-bubble + spacing).
        <EmptyState
          icon={<Pill className="size-6" />}
          title={t("medications.emptyTitle")}
          description={t("medications.emptyDescription")}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t("medications.firstMedication")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {/* Active medications */}
          {activeMeds.length > 0 && (
            <div className="space-y-3.5">
              <div className="grid gap-4 sm:grid-cols-2">
                {activeMeds.map((med) =>
                  med.treatmentClass === "GLP1" ? (
                    <Glp1MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      onOpenAdvanced={openAdvanced}
                    />
                  ) : (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      onOpenAdvanced={openAdvanced}
                    />
                  ),
                )}
              </div>
            </div>
          )}

          {/* Inactive medications */}
          {inactiveMeds.length > 0 && (
            <div className="space-y-3.5">
              <h2 className="text-muted-foreground text-sm font-medium">
                {t("common.inactive")} ({inactiveMeds.length})
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {inactiveMeds.map((med) =>
                  med.treatmentClass === "GLP1" ? (
                    <Glp1MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      onOpenAdvanced={openAdvanced}
                    />
                  ) : (
                    <MedicationCard
                      key={med.id}
                      medication={med}
                      onEdit={openEdit}
                      onOpenHistory={openHistory}
                      onOpenAdvanced={openAdvanced}
                    />
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* v1.5.5 — the per-card kebab triggers used to open inline
          IntakeImportDialog / ApiEndpointDialog mounts here, but both
          state slots were only ever set from inside the dialogs
          themselves (never from a list-card prop) so the inline
          mounts were dead code. v1.5.5 retires both on the list page:
          the import dialog lives in the detail-page intake-history
          header (see `src/components/medications/intake-import-dialog.tsx`),
          the API endpoint moves to the detail-page Settings → Externe
          Integration sub-row. */}

      {/* v1.5.4 — modal-wizard mount. The same component drives both
          create (no initial) and edit (hydrates from the medication's
          payload). The wizard owns its own ResponsiveSheet shell with
          the dialog/sheet split and the sticky footer. */}
      <MedicationWizardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={editingMed ? "edit" : "create"}
        initial={editingMed ? medicationToPayload(editingMed) : undefined}
        onSuccess={closeDialog}
      />

      {/* v1.7.1 — one shared advanced-settings sheet for every card.
          Reuses the exact component the detail page mounts (Data /
          Reminders / Lifecycle / Danger zone); the card's sliders button
          selects the medication and opens it. Not duplicated per card. */}
      {advancedMed && (
        <AdvancedSettingsSheet
          open={!!advancedMed}
          onOpenChange={(open) => {
            if (!open) setAdvancedMed(null);
          }}
          medicationId={advancedMed.id}
          medicationName={advancedMed.name}
          treatmentClass={advancedMed.treatmentClass}
          active={advancedMed.active}
          startsOn={advancedMed.startsOn}
          endsOn={advancedMed.endsOn}
          notificationsEnabled={advancedMed.notificationsEnabled}
          reminderGraceMinutes={
            advancedMed.schedules[0]?.reminderGraceMinutes ?? null
          }
          intakeCount={advancedIntakeCount ?? 0}
        />
      )}
    </div>
  );
}

/**
 * Map a `Medication` row from `GET /api/medications` onto the
 * `MedicationPayload` shape the wizard's edit-path hydrator consumes.
 * Mirrors the schedule pass-through the v1.5.3 flat form relied on so
 * legacy cadences round-trip through the bridge cleanly.
 */
function medicationToPayload(med: Medication): MedicationPayload {
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

