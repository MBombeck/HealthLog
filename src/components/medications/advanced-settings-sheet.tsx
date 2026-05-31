"use client";

/**
 * v1.7.0 — Advanced settings sheet.
 *
 * Widened to the `2xl` ResponsiveSheet token (672px desktop) and
 * regrouped from three stacked section cards into four labelled groups
 * under one consistent visual system (R-medui §5):
 *
 *   - Data: real CSV/JSON import + external-API endpoint / token.
 *   - Reminders: notifications switch + reminder window (grace).
 *   - Lifecycle: pause/resume + end course + phases.
 *   - Danger zone: purge intake history + delete medication.
 *
 * Button styling is consistent: reversible / neutral actions are
 * `outline`, destructive actions are `destructive font-semibold`,
 * toggles are switches wrapped in labels. The CSV import is promoted
 * from a one-line stub to a real button that opens the existing
 * `<IntakeImportDialog>` (mounted by the page; opened via
 * `onOpenImport`).
 *
 * The Phasen button is sibling-swapped, not nested: `onRequestPhaseSheet`
 * closes this sheet first and lets the parent open the phase sheet so
 * the modal stack never exceeds two (D-3 §10 invariant 7). Each control
 * self-saves, so the footer slot stays empty.
 */

import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SettingsGroup } from "@/components/medications/settings-group";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { NotificationsBody } from "@/components/medications/sections/notifications-section";
import {
  GraceRow,
  PhasesRow,
} from "@/components/medications/sections/settings-section";
import {
  DangerZoneBody,
  LifecycleManageBody,
} from "@/components/medications/sections/destructive-zone-section";
import { useTranslations } from "@/lib/i18n/context";

export interface AdvancedSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicationId: string;
  medicationName: string;
  treatmentClass?: string;
  active: boolean;
  startsOn?: string | null;
  endsOn?: string | null;
  notificationsEnabled: boolean;
  reminderGraceMinutes: number | null;
  intakeCount: number;
  /**
   * Sibling-swap the phase sheet: the parent closes this sheet and
   * opens `<PhaseConfigSheet>` so the two never stack (G-1 §5).
   */
  onRequestPhaseSheet?: () => void;
  /**
   * v1.7.0 — opens the page-owned `<IntakeImportDialog>` from the Data
   * group's CSV/JSON import button.
   */
  onOpenImport?: () => void;
}

export function AdvancedSettingsSheet({
  open,
  onOpenChange,
  medicationId,
  medicationName,
  treatmentClass,
  active,
  startsOn,
  endsOn,
  notificationsEnabled,
  reminderGraceMinutes,
  intakeCount,
  onRequestPhaseSheet,
  onOpenImport,
}: AdvancedSettingsSheetProps) {
  const { t } = useTranslations();
  const isGlp1 = treatmentClass === "GLP1";

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("medications.detail.advanced.title")}
      contentWidth="2xl"
      bodyClassName="gap-6"
    >
      <div className="space-y-8" data-slot="advanced-settings-sheet-body">
        {/* DATA — CSV/JSON import + external API endpoint */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.data")}
          dataSlot="advanced-group-data"
        >
          <div className="space-y-2" data-slot="advanced-csv-import-block">
            <div className="space-y-1">
              <p className="text-foreground text-sm font-medium">
                {t("medications.detail.advanced.csvImport.title")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("medications.detail.advanced.csvImport.helper")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenImport?.()}
              className="min-h-11 sm:min-h-9"
              data-slot="advanced-csv-import-button"
            >
              <Upload aria-hidden="true" className="h-4 w-4" />
              {t("medications.detail.advanced.csvImport.button")}
            </Button>
          </div>

          <Separator />

          <ApiTokensRow
            medicationId={medicationId}
            medicationName={medicationName}
          />
        </SettingsGroup>

        {/* REMINDERS — notifications + reminder window */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.reminders")}
          dataSlot="advanced-group-reminders"
        >
          <NotificationsBody
            medicationId={medicationId}
            notificationsEnabled={notificationsEnabled}
          />

          <Separator />

          <GraceRow
            medicationId={medicationId}
            reminderGraceMinutes={reminderGraceMinutes}
          />
        </SettingsGroup>

        {/* LIFECYCLE — pause/resume + end course + phases */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.lifecycle")}
          dataSlot="advanced-group-lifecycle"
        >
          <LifecycleManageBody
            medicationId={medicationId}
            medicationName={medicationName}
            active={active}
            onAfterAction={() => onOpenChange(false)}
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
        </SettingsGroup>

        {/* DANGER ZONE — purge + delete */}
        <SettingsGroup
          label={t("medications.detail.advanced.group.danger")}
          dataSlot="advanced-group-danger"
        >
          <DangerZoneBody
            medicationId={medicationId}
            medicationName={medicationName}
            intakeCount={intakeCount}
            onAfterAction={() => onOpenChange(false)}
          />
        </SettingsGroup>
      </div>
    </ResponsiveSheet>
  );
}
