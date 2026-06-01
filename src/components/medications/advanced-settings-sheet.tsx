"use client";

/**
 * v1.7.0 — Advanced settings sheet.
 * v1.7.2 — widened to `4xl` and re-laid into a responsive two-column
 * grid so a normal desktop viewport shows every group without forcing
 * a long single-column scroll.
 *
 * Four labelled groups under one consistent visual system (R-medui §5):
 *
 *   - Data: intake Import + medications CSV Export (co-located) +
 *     external-API endpoint / token.
 *   - Reminders: notifications switch + reminder window (grace).
 *   - Lifecycle: pause/resume + end course + phases.
 *   - Danger zone: purge intake history + delete medication.
 *
 * Layout: on `lg+` the first three groups flow into a two-column grid —
 * the Data group (tallest, with the export toggle + token snippets)
 * holds the left column; Reminders + Lifecycle stack down the right.
 * The Danger zone always spans the full width at the bottom, set off by
 * its own destructive-tinted card, so an irreversible action never
 * shares a column with a routine toggle. On `<lg` everything stacks in
 * the documented Data → Reminders → Lifecycle → Danger order.
 *
 * Button styling is consistent: reversible / neutral actions are
 * `outline`, destructive actions are `destructive font-semibold`,
 * toggles are switches wrapped in labels.
 *
 * The Phasen button is sibling-swapped, not nested: `onRequestPhaseSheet`
 * closes this sheet first and lets the parent open the phase sheet so
 * the modal stack never exceeds two (D-3 §10 invariant 7). Each control
 * self-saves, so the footer slot stays empty.
 */

import { Separator } from "@/components/ui/separator";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { SettingsGroup } from "@/components/medications/settings-group";
import { ApiTokensRow } from "@/components/medications/sections/api-tokens-row";
import { DataPortabilityRow } from "@/components/medications/sections/data-portability-row";
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
   * group's import button.
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
      contentWidth="4xl"
      bodyClassName="gap-6"
    >
      <div className="space-y-6" data-slot="advanced-settings-sheet-body">
        {/* Top region: Data + Reminders + Lifecycle in a two-column grid
            on lg+, single column below. `items-start` keeps each group
            top-aligned so the shorter right column never stretches. */}
        <div className="grid items-start gap-6 lg:grid-cols-2">
          {/* DATA — import + export + external API. Tallest group → left
              column on lg+ so the right column's two shorter groups
              balance against it. */}
          <SettingsGroup
            label={t("medications.detail.advanced.group.data")}
            dataSlot="advanced-group-data"
          >
            <DataPortabilityRow
              medicationId={medicationId}
              onOpenImport={onOpenImport}
            />

            <Separator />

            <ApiTokensRow
              medicationId={medicationId}
              medicationName={medicationName}
            />
          </SettingsGroup>

          {/* Right column: Reminders + Lifecycle stacked. */}
          <div className="space-y-6">
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
          </div>
        </div>

        {/* DANGER ZONE — purge + delete. Full-width at the bottom, set
            off by the destructive-tinted card inside the body so an
            irreversible action never shares a column with a toggle. */}
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
