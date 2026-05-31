"use client";

/**
 * v1.5.5 D-3 §9.7 — Settings rows.
 *
 * v1.7.0 — the monolithic "Settings" card is decomposed into reusable
 * rows so the redesigned `<AdvancedSettingsSheet>` can slot each one
 * under the right group: API tokens → Data, Grace → Reminders,
 * Phasen → Lifecycle. The standalone `<SettingsSection>` wrapper stays
 * (it composes the rows under one section card) so existing callers +
 * tests keep working. The CSV-import stub is gone — the sheet's Data
 * group carries a real import button.
 *
 * Per H-4-UX: the Grace row's label flags it as primary-schedule
 * scoped so the user knows a multi-schedule medication does not get a
 * fan-out from this control.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { MedicationDetailSection } from "@/components/medications/medication-detail-section";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { PhaseConfigSheet } from "@/components/medications/sections/phase-config-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";

export interface SettingsSectionProps {
  medicationId: string;
  medicationName: string;
  treatmentClass?: string;
  startsOn?: string | null;
  endsOn?: string | null;
  reminderGraceMinutes?: number | null;
  /**
   * v1.5.6 G-1 §5 — sibling-swap the phase sheet. When provided, the
   * Phasen button hands control to the parent (which closes the
   * hosting sheet before opening `<PhaseConfigSheet>`) instead of the
   * self-managed `phaseSheetOpen` state, so the two sheets never
   * stack. Absent on the standalone surface, where the section owns
   * its own phase sheet.
   */
  onRequestPhaseSheet?: () => void;
}

/**
 * v1.7.0 — primary-schedule reminder-window (grace) row. Self-saves via
 * `PUT /api/medications/[id]` with a top-level `reminderGraceMinutes`.
 */
export function GraceRow({
  medicationId,
  reminderGraceMinutes,
}: {
  medicationId: string;
  reminderGraceMinutes?: number | null;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [graceValue, setGraceValue] = useState(
    typeof reminderGraceMinutes === "number" ? reminderGraceMinutes : 30,
  );
  const [graceBusy, setGraceBusy] = useState(false);

  async function saveGrace() {
    if (graceBusy) return;
    setGraceBusy(true);
    try {
      // Primary-schedule scope: the PUT body's schedules array is
      // absent so the server preserves existing schedules; the route
      // accepts top-level `reminderGraceMinutes` as a primary-schedule
      // override on the v1.5.4 flat-form bridge.
      const res = await fetch(`/api/medications/${medicationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reminderGraceMinutes: graceValue }),
      });
      if (!res.ok) {
        toast.error(t("medications.detail.settings.grace.failed"));
        return;
      }
      await invalidateKeys(queryClient, medicationDependentKeys);
      toast.success(t("medications.detail.settings.grace.saved"));
    } catch {
      toast.error(t("medications.detail.settings.grace.failed"));
    } finally {
      setGraceBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-slot="medication-detail-grace-row">
      <Label
        htmlFor="medication-detail-grace-input"
        className="text-foreground text-sm font-medium"
      >
        {t("medications.detail.settings.grace.label")}
      </Label>
      <p className="text-muted-foreground text-xs">
        {t("medications.detail.settings.grace.primaryScheduleNote")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="medication-detail-grace-input"
          type="number"
          min={0}
          max={720}
          value={graceValue}
          onChange={(e) => setGraceValue(Number(e.target.value) || 0)}
          className="w-24"
        />
        <span className="text-muted-foreground text-xs">
          {t("medications.detail.settings.grace.unit")}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void saveGrace()}
          disabled={graceBusy}
          aria-busy={graceBusy || undefined}
          className="min-h-11 sm:min-h-9"
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * v1.7.0 — phases / course-window row. GLP-1 only; the button mounts
 * once a course window is set, otherwise an italic hint. When
 * `onRequestPhaseSheet` is provided the parent orchestrates the
 * sibling-swap; otherwise the row self-mounts `<PhaseConfigSheet>`.
 */
export function PhasesRow({
  medicationId,
  treatmentClass,
  startsOn,
  endsOn,
  onRequestPhaseSheet,
}: {
  medicationId: string;
  treatmentClass?: string;
  startsOn?: string | null;
  endsOn?: string | null;
  onRequestPhaseSheet?: () => void;
}) {
  const { t } = useTranslations();
  const [phaseSheetOpen, setPhaseSheetOpen] = useState(false);

  const isGlp1 = treatmentClass === "GLP1";
  const hasCourseWindow = Boolean(startsOn) && Boolean(endsOn);
  const showPhases = isGlp1 && hasCourseWindow;

  if (!isGlp1) return null;

  return (
    <>
      <div
        className="space-y-2"
        data-slot="medication-detail-phase-management-row"
      >
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.phaseConfig")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.phaseConfigDescription")}
          </p>
        </div>
        {showPhases ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              onRequestPhaseSheet
                ? onRequestPhaseSheet()
                : setPhaseSheetOpen(true)
            }
            className="min-h-11 sm:min-h-9"
            data-slot="medication-detail-phase-management-button"
          >
            {t("medications.detail.settings.phases.openButton")}
          </Button>
        ) : (
          <p
            className="text-muted-foreground text-xs italic"
            data-slot="medication-detail-phase-management-empty"
          >
            {t("medications.detail.settings.phases.requiresCourseWindow")}
          </p>
        )}
      </div>

      {showPhases && !onRequestPhaseSheet && (
        <PhaseConfigSheet
          medicationId={medicationId}
          open={phaseSheetOpen}
          onOpenChange={setPhaseSheetOpen}
        />
      )}
    </>
  );
}

/**
 * Standalone section wrapper — composes the rows under one section
 * card. Retained for callers / tests that expect the bundled shape.
 */
export function SettingsSection({
  medicationId,
  medicationName,
  treatmentClass,
  startsOn,
  endsOn,
  reminderGraceMinutes,
  onRequestPhaseSheet,
}: SettingsSectionProps) {
  const { t } = useTranslations();
  const isGlp1 = treatmentClass === "GLP1";

  return (
    <MedicationDetailSection
      titleId="medication-detail-settings-heading"
      title={t("medications.detail.settings.title")}
      dataSlot="medication-detail-settings-section"
    >
      <div className="space-y-4" data-slot="medication-detail-settings-body">
        <ApiTokensRow
          medicationId={medicationId}
          medicationName={medicationName}
        />

        {isGlp1 && (
          <>
            <Separator />
            <PhasesRow
              medicationId={medicationId}
              treatmentClass={treatmentClass}
              startsOn={startsOn}
              endsOn={endsOn}
              onRequestPhaseSheet={onRequestPhaseSheet}
            />
          </>
        )}

        <Separator />

        <GraceRow
          medicationId={medicationId}
          reminderGraceMinutes={reminderGraceMinutes}
        />
      </div>
    </MedicationDetailSection>
  );
}
