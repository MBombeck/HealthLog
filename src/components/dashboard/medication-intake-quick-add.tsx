"use client";

import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateTimeInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Pill, Plus } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  medicationDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import {
  reduceCurrentWindowStatus,
  toBerlinDate,
  type ScheduleWindowInput,
} from "@/lib/medications/window-status";

/**
 * v1.4.37 W7b — dashboard "Hinzufügen" → "Medikamenteneinnahme" quick-add.
 *
 * Marc's brief: the dashboard's top-right "Hinzufügen" menu logs
 * measurements and mood entries; add a medication-intake action so a
 * dose can be logged in a few taps without leaving the dashboard.
 *
 * Form shape mirrors `MoodForm` / `MeasurementForm`:
 *
 *   1. Medication picker. Auto-selects the only active medication when
 *      the user has one; otherwise defaults to the first medication
 *      whose schedule window is currently open (the cool/easy slice).
 *      Falls back to the most-recently-created entry when nothing is
 *      due. Disabled when the user has no active medications — the
 *      sheet body renders an EmptyState-style hint instead of an
 *      unusable form.
 *   2. Dose. Pre-filled from the medication's catalogue dose for
 *      visual confirmation ("this is the strength I'm logging").
 *      v1.4.37 W10 — rendered read-only because the POST body has no
 *      `dose` field; any user edit would be silently dropped. When
 *      the user wants to record a half/double dose they still edit
 *      the medication itself on `/medications` until the v1.4.38
 *      schema grows a `doseOverride` slot. Hint copy below the
 *      field warns about the constraint so the user's mental model
 *      tracks what the server persists.
 *   3. Time taken. Defaults to `now` (local datetime-local format
 *      shaped the same as `MoodForm`).
 *
 * On success: invalidate `medicationDependentKeys` (medications +
 * analytics + insights + intake-summary + achievements) PLUS the
 * inline per-medication compliance chart key so the detail page tile
 * refreshes if it happens to be mounted elsewhere in the app.
 *
 * Mounted inside `<ResponsiveSheet>` from `page.tsx`; the action row
 * is portalled into the sheet's sticky footer slot via `footerSlot`,
 * matching the `MoodForm` / `MeasurementForm` contract so the Save
 * button stays reachable above the mobile keyboard.
 */

interface Schedule extends ScheduleWindowInput {
  id: string;
  label: string | null;
  dose: string | null;
}

export interface MedicationOption {
  id: string;
  name: string;
  dose: string;
  active: boolean;
  schedules: Schedule[];
  lastTakenAt: string | null;
  todayEventCount: number | null;
}

interface MedicationIntakeQuickAddProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  /**
   * v1.4.27 R4 RC2 contract — when mounted inside the responsive sheet,
   * the parent passes the sheet's sticky footer slot so the action row
   * (Cancel + Save) renders pinned above the soft keyboard. The
   * `<form>` keeps `submit-on-Enter` working through the HTML `form`
   * attribute on the portalled Save button.
   */
  footerSlot?: HTMLElement | null;
}

function getDefaultIntakeAtValue(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/**
 * Pick the medication that should be pre-selected when the sheet opens.
 *
 * Priority:
 *   1. The active medication whose schedule window is currently open
 *      (or late / very_late) — this is the "due now" surface.
 *   2. The single active medication when the user has exactly one.
 *   3. The first active medication alphabetically (stable fallback).
 *
 * Returns the medication id or `null` when no active medication exists.
 */
export function pickDefaultMedicationId(
  options: MedicationOption[],
  now: Date = new Date(),
  thresholds: { lateMinutes: number; missedMinutes: number } = {
    lateMinutes: 120,
    missedMinutes: 240,
  },
): string | null {
  const actives = options.filter((m) => m.active);
  if (actives.length === 0) return null;
  if (actives.length === 1) return actives[0].id;

  const nowBerlin = toBerlinDate(now);
  const due = actives.find((m) => {
    const status = reduceCurrentWindowStatus({
      schedules: m.schedules,
      nowBerlin,
      lateMinutes: thresholds.lateMinutes,
      missedMinutes: thresholds.missedMinutes,
      active: true,
      lastTakenAt: m.lastTakenAt,
      todayEventCount: m.todayEventCount ?? 0,
    });
    return status.status !== null;
  });
  if (due) return due.id;

  // Stable alphabetical fallback when nothing is currently due.
  const sorted = [...actives].sort((a, b) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" }),
  );
  return sorted[0]?.id ?? null;
}

export function MedicationIntakeQuickAdd({
  onSuccess,
  onCancel,
  footerSlot,
}: MedicationIntakeQuickAddProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: medicationsRaw, isLoading: medicationsLoading } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      const res = await fetch("/api/medications");
      if (!res.ok) throw new Error("Failed to load medications");
      const json = await res.json();
      return json.data as MedicationOption[];
    },
  });

  const medications = useMemo(
    () =>
      Array.isArray(medicationsRaw)
        ? medicationsRaw.filter((m) => m.active)
        : [],
    [medicationsRaw],
  );
  const sortedMedications = useMemo(
    () =>
      [...medications].sort((a, b) =>
        a.name.localeCompare(b.name, "de", { sensitivity: "base" }),
      ),
    [medications],
  );

  // User-driven medication override; `null` means "use the auto-pick".
  // Derived selection prefers the override, falls back to the heuristic
  // so a freshly-mounted sheet shows the cool/easy default without any
  // effect-driven setState.
  const [medicationOverride, setMedicationOverride] = useState<string | null>(
    null,
  );
  // v1.4.37 W10 — the dose field is informational only. The intake
  // POST body has no `dose` slot, so any user edit would be silently
  // dropped on submit. Until the v1.4.38 schema grows a `doseOverride`
  // field, render the input as read-only so the user's mental model
  // tracks what the server actually persists. The state holder is
  // kept (as `null`) so the medication-switch handler still resets
  // the slot cleanly if the schema ever grows the field.
  const [doseOverride, setDoseOverride] = useState<string | null>(null);
  const [takenAt, setTakenAt] = useState<string>(getDefaultIntakeAtValue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;
  const formId = useId();

  const defaultMedicationId = useMemo(
    () => pickDefaultMedicationId(medications),
    [medications],
  );
  const medicationId = medicationOverride ?? defaultMedicationId ?? "";
  const selectedMedication = medications.find((m) => m.id === medicationId);
  const dose = doseOverride ?? selectedMedication?.dose ?? "";

  function handleMedicationChange(value: string) {
    setMedicationOverride(value);
    // Reset the dose override when the medication changes so the new
    // default flows through on the next render. The dose field is
    // currently read-only (see v1.4.37 W10 note above), but the reset
    // stays in place so the slot is ready to switch back to editable
    // when the v1.4.38 doseOverride schema lands.
    setDoseOverride(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!medicationId || loading) return;
    setError(null);
    setLoading(true);

    try {
      const timestamp = new Date(takenAt).toISOString();
      const res = await fetch(`/api/medications/${medicationId}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          takenAt: timestamp,
          skipped: false,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        setError(
          typeof json?.error === "string"
            ? json.error
            : t("dashboard.medicationIntakeQuickAdd.saveError"),
        );
        setLoading(false);
        return;
      }

      await invalidateKeys(queryClient, medicationDependentKeys);
      // Fan-out to every inline compliance chart key (one per medication)
      // so the detail-page tile refreshes when the user re-enters it.
      await queryClient.invalidateQueries({
        queryKey: ["compliance-chart-inline"],
      });

      toast.success(t("common.saved"));
      onSuccess?.();
    } catch {
      setError(t("dashboard.medicationIntakeQuickAdd.saveError"));
    } finally {
      setLoading(false);
    }
  }

  const footerNode = (
    <div className="flex w-full items-center justify-end gap-2">
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={loading}
          className="min-h-11 sm:min-h-9"
        >
          {t("common.cancel")}
        </Button>
      )}
      <Button
        type="submit"
        form={formId}
        disabled={loading || !medicationId || medications.length === 0}
        className="min-h-11 sm:min-h-9"
      >
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Plus className="mr-2 h-4 w-4" />
        )}
        {t("common.save")}
      </Button>
    </div>
  );

  // Empty-state branch: the user has no active medications. Render a
  // hint + CTA into the body so the user has a single tap into the
  // medication-creation surface. The form itself is suppressed so we
  // don't ship an unusable Save button.
  if (!medicationsLoading && medications.length === 0) {
    const emptyFooter = (
      <div className="flex w-full items-center justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="min-h-11 sm:min-h-9"
          >
            {t("common.close")}
          </Button>
        )}
      </div>
    );
    return (
      <>
        <div
          data-testid="medication-intake-quick-add-empty"
          className="flex flex-col items-center gap-3 py-4 text-center"
          role="status"
          aria-live="polite"
        >
          <Pill className="text-muted-foreground h-6 w-6" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t("dashboard.medicationIntakeQuickAdd.emptyTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("dashboard.medicationIntakeQuickAdd.emptyDescription")}
            </p>
          </div>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
          >
            <Link href="/medications">
              {t("dashboard.medicationIntakeQuickAdd.emptyCta")}
            </Link>
          </Button>
        </div>
        {footerSlot ? createPortal(emptyFooter, footerSlot) : emptyFooter}
      </>
    );
  }

  return (
    <form
      id={formId}
      onSubmit={handleSubmit}
      className="space-y-4"
      data-testid="medication-intake-quick-add-form"
    >
      <div className="space-y-2">
        <Label htmlFor="medication-intake-medication">
          {t("dashboard.medicationIntakeQuickAdd.medicationLabel")}
        </Label>
        <Select
          value={medicationId}
          onValueChange={handleMedicationChange}
          disabled={medicationsLoading || medications.length === 0}
        >
          <SelectTrigger
            id="medication-intake-medication"
            data-testid="medication-intake-quick-add-medication"
            className="min-h-11"
          >
            <SelectValue
              placeholder={t(
                "dashboard.medicationIntakeQuickAdd.medicationPlaceholder",
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {sortedMedications.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                <span className="flex items-center gap-2">
                  <Pill
                    className="text-muted-foreground h-4 w-4"
                    aria-hidden="true"
                  />
                  <span>{m.name}</span>
                  {m.dose ? (
                    <span className="text-muted-foreground text-xs">
                      ({m.dose})
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="medication-intake-dose">
          {t("dashboard.medicationIntakeQuickAdd.doseLabel")}
        </Label>
        <Input
          id="medication-intake-dose"
          data-testid="medication-intake-quick-add-dose"
          value={dose}
          readOnly
          aria-readonly="true"
          tabIndex={-1}
          placeholder={
            selectedMedication?.dose ??
            t("dashboard.medicationIntakeQuickAdd.dosePlaceholder")
          }
          autoComplete="off"
          className="min-h-11 bg-muted/40"
        />
        <p className="text-muted-foreground text-xs">
          {t("dashboard.medicationIntakeQuickAdd.doseHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="medication-intake-taken-at">
          {t("dashboard.medicationIntakeQuickAdd.timeLabel")}
        </Label>
        <DateTimeInput
          id="medication-intake-taken-at"
          data-testid="medication-intake-quick-add-taken-at"
          value={takenAt}
          onChange={(e) => setTakenAt(e.target.value)}
          required
          aria-required="true"
          aria-invalid={!!error || undefined}
          aria-describedby={errorDescriptor}
        />
      </div>

      {error && (
        <div
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
        >
          {error}
        </div>
      )}

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
    </form>
  );
}
