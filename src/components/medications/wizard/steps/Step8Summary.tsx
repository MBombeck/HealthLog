"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useTranslations } from "@/lib/i18n/context";

import {
  type MedicationPayload,
  summariseCadence,
  summariseScheduleDraft,
  type WizardPayload,
} from "../wizard-payload";

export interface Step8SummaryProps {
  payload: WizardPayload;
  applyPartial: (partial: Partial<WizardPayload>) => void;
  mode: "create" | "edit";
  initial?: MedicationPayload;
  submitError: string | null;
  /** Jump to Step 5 with the schedule at `index` as the active draft. */
  onEditSchedule: (index: number) => void;
  /** Remove the schedule at `index` from the list. */
  onRemoveSchedule: (index: number) => void;
  /** Append a fresh schedule and jump to Step 5 of the new entry. */
  onAddSchedule: () => void;
}

/**
 * v1.5.4 — Step 8: schedule list + reminders + summary.
 *
 * Compose-mode lands here. Every entry in `payload.schedules` renders
 * as a small card with a plain-language summary, a "Bearbeiten" link
 * back into Step 5 of that schedule, and a "Entfernen" button. The
 * "+ Weiteren Zeitplan hinzufügen" card at the bottom of the list
 * appends a fresh empty draft. The medication-level reminders toggle
 * stays at the bottom.
 *
 * The first summary block at the top keeps the v1.5.4 single-schedule
 * shape so single-schedule paths read identically to before. The
 * per-schedule cards underneath only render when more than one
 * schedule exists.
 */
export function Step8Summary({
  payload,
  applyPartial,
  submitError,
  onEditSchedule,
  onRemoveSchedule,
  onAddSchedule,
}: Step8SummaryProps) {
  const { t } = useTranslations();
  const topSummary = summariseCadence(payload, t);
  const canRemove = payload.schedules.length > 1;

  return (
    <div className="space-y-4" data-slot="wizard-step8">
      <div
        className="bg-muted/40 rounded-md border p-3 text-sm"
        data-slot="wizard-summary"
      >
        <p className="mb-1 font-medium">
          {t("medications.wizard.summary.title")}
        </p>
        <p>{topSummary}</p>
      </div>

      <div className="space-y-2" data-slot="wizard-schedule-list">
        {payload.schedules.map((draft, index) => {
          const cardSummary = summariseScheduleDraft(draft, t);
          return (
            <div
              key={index}
              className="border-border/70 rounded-md border p-3"
              data-slot="wizard-schedule-card"
              data-index={index}
            >
              <p className="text-sm">{cardSummary}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => onEditSchedule(index)}
                  data-slot="wizard-schedule-edit"
                  data-index={index}
                >
                  {t("medications.wizard.compose.list.edit")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-destructive h-8 gap-1 px-2 text-xs"
                  onClick={() => onRemoveSchedule(index)}
                  disabled={!canRemove}
                  data-slot="wizard-schedule-remove"
                  data-index={index}
                  aria-label={t("medications.wizard.compose.list.remove")}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("medications.wizard.compose.list.remove")}
                </Button>
              </div>
            </div>
          );
        })}

        {!canRemove && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="wizard-schedule-remove-disabled-hint"
          >
            {t("medications.wizard.compose.list.removeDisabled")}
          </p>
        )}

        {payload.mode !== "oneShot" && (
          <button
            type="button"
            onClick={onAddSchedule}
            data-slot="wizard-schedule-add"
            className={[
              "border-border/70 hover:bg-muted/40 focus-visible:ring-ring",
              "flex w-full items-center justify-center gap-2 rounded-md border border-dashed",
              "p-3 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2",
            ].join(" ")}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("medications.wizard.compose.list.add")}
          </button>
        )}
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label
            htmlFor="wizard-reminders"
            className="text-sm font-medium"
          >
            {t("medications.wizard.steps.step8.remindersLabel")}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t("medications.wizard.steps.step8.remindersDescription")}
          </p>
        </div>
        <Switch
          id="wizard-reminders"
          checked={payload.notificationsEnabled}
          onCheckedChange={(checked) =>
            applyPartial({ notificationsEnabled: checked })
          }
          data-slot="wizard-reminders-toggle"
          aria-label={t("medications.wizard.steps.step8.remindersLabel")}
        />
      </div>

      {submitError && (
        <p
          className="text-destructive text-sm"
          role="alert"
          data-slot="wizard-submit-error"
        >
          {submitError}
        </p>
      )}
    </div>
  );
}
