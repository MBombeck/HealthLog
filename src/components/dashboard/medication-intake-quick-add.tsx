"use client";

import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateTimeField } from "@/components/ui/date-time-field";
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
import type { ScheduleWindowInput } from "@/lib/medications/window-status";
import {
  resolveMedicationSelectionId,
  type DefaultMedicationOption,
} from "@/lib/medications/default-medication";
import { useAuth } from "@/hooks/use-auth";
import { ApiError, apiGet, apiPost } from "@/lib/api/api-fetch";
import { runUndoIntake } from "@/components/medications/use-medication-intake";

/**
 * v1.4.37 W7b — dashboard "Hinzufügen" → "Medikamenteneinnahme" quick-add.
 *
 * The maintainer's brief: the dashboard's top-right "Hinzufügen" menu logs
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
 *      v1.16.4 — editable: the intake POST body grew a `doseTaken`
 *      override slot, so a half/double dose can be recorded for THIS
 *      take. An untouched (or configured-dose) value sends nothing and
 *      the take records under the medication's dose as before.
 *   3. Time taken. Defaults to `now` (local datetime-local format
 *      shaped the same as `MoodForm`).
 *
 * On success: invalidate `medicationDependentKeys` (medications +
 * analytics + insights + achievements) PLUS the
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

export interface MedicationOption extends DefaultMedicationOption {
  dose: string;
  schedules: Schedule[];
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

export function MedicationIntakeQuickAdd({
  onSuccess,
  onCancel,
  footerSlot,
}: MedicationIntakeQuickAddProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.16.9 — the auto-pick reasons in the PROFILE timezone (the same
  // source the cards use); Berlin stays the last-resort fallback so
  // logged-out mounts behave unchanged.
  const { user } = useAuth();
  const userTz = user?.timezone || "Europe/Berlin";

  const { data: medicationsRaw, isLoading: medicationsLoading } = useQuery({
    queryKey: queryKeys.medications(),
    queryFn: async () => {
      return apiGet<MedicationOption[]>("/api/medications");
    },
    // v1.4.38 — share the parent dashboard's medications cache.
    // `queryKeys.medications()` resolves to `["medications"]` — the
    // same key the dashboard's onboarding checklist subscriber holds.
    // Without a staleTime the sheet-mount triggers a fresh
    // `/api/medications` GET on every open even when the parent cache
    // already has current data. Match the dashboard's 60s window and
    // skip the refetch-on-mount so opening the sheet inside the TTL
    // reads straight from the React-Query cache.
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
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
  // v1.16.4 — the dose field is editable: the intake POST body grew a
  // `doseTaken` slot, so a half/double dose can be recorded per intake.
  // `null` = untouched → the medication's configured dose flows through
  // and nothing extra is sent; an edit that differs from the configured
  // dose is persisted as the per-intake override.
  const [doseOverride, setDoseOverride] = useState<string | null>(null);
  const [takenAt, setTakenAt] = useState<string>(getDefaultIntakeAtValue);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionNow] = useState(() => new Date());

  const errorId = useId();
  const errorDescriptor = error ? errorId : undefined;
  const formId = useId();

  const medicationId =
    resolveMedicationSelectionId(
      medications,
      medicationOverride,
      selectionNow,
      undefined,
      userTz,
    ) ?? "";
  const selectedMedication = medications.find((m) => m.id === medicationId);
  const dose = doseOverride ?? selectedMedication?.dose ?? "";

  function handleMedicationChange(value: string) {
    setMedicationOverride(value);
    // Reset the dose override when the medication changes so the new
    // medication's configured dose flows through on the next render.
    setDoseOverride(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!medicationId || loading) return;
    setError(null);
    setLoading(true);

    try {
      const timestamp = new Date(takenAt).toISOString();
      // v1.16.4 — only a deliberate deviation travels: an untouched or
      // configured-dose value sends nothing, so the row stays NULL and
      // read paths fall back to the medication's dose.
      const trimmedDose = dose.trim();
      const doseDeviates =
        trimmedDose.length > 0 &&
        trimmedDose !== (selectedMedication?.dose ?? "").trim();
      // v1.30.1 M7 — the route returns the created event
      // (`apiSuccess(event, 201)`), same shape the card's take/skip path
      // already reads; the id drives the new Undo action below.
      const created = await apiPost<{ id?: string } | undefined>(
        `/api/medications/${medicationId}/intake`,
        {
          takenAt: timestamp,
          skipped: false,
          ...(doseDeviates && { doseTaken: trimmedDose }),
        },
      );
      const eventId = created?.id;

      await invalidateKeys(queryClient, medicationDependentKeys);
      // Fan-out to every inline compliance chart key (one per medication)
      // so the detail-page tile refreshes when the user re-enters it.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.complianceChartInline(),
      });

      toast.success(
        t("common.saved"),
        eventId && selectedMedication
          ? {
              action: {
                label: t("medications.intakeUndo"),
                onClick: () =>
                  void runUndoIntake({
                    medication: {
                      id: medicationId,
                      name: selectedMedication.name,
                    },
                    eventId,
                    t,
                    queryClient,
                  }),
              },
            }
          : undefined,
      );
      onSuccess?.();
    } catch (err) {
      setError(
        err instanceof ApiError && err.message
          ? err.message
          : t("dashboard.medicationIntakeQuickAdd.saveError"),
      );
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
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
        {t("common.save")}
      </Button>
    </div>
  );

  // Empty-state branch: the user has no active medications. Render a
  // hint into the body and promote the "Medikament anlegen" CTA into
  // the sheet footer slot so the primary action lives where the user
  // expects it (matches the populated form's Save-button slot). The
  // form itself is suppressed so we don't ship an unusable Save
  // button.
  //
  // v1.4.38 W-D P2-1 — symmetry fix. The previous shape rendered the
  // CTA in the body and a footer with only the Close button, which
  // read as the dialog losing a save button. Now the body carries the
  // hint and the footer carries `<Cancel> <Link asChild>Medikament
  // anlegen</Link>` so the footer-slot promise holds across both
  // branches.
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
            {t("common.cancel")}
          </Button>
        )}
        <Button asChild className="min-h-11 sm:min-h-9">
          <Link href="/medications">
            {t("dashboard.medicationIntakeQuickAdd.emptyCta")}
          </Link>
        </Button>
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
          >
            <SelectValue
              placeholder={t(
                "dashboard.medicationIntakeQuickAdd.medicationPlaceholder",
              )}
            >
              {selectedMedication ? (
                <span className="flex items-center gap-2">
                  <Pill
                    className="text-muted-foreground h-4 w-4"
                    aria-hidden="true"
                  />
                  <span>{selectedMedication.name}</span>
                  {selectedMedication.dose ? (
                    <span className="text-muted-foreground text-xs">
                      ({selectedMedication.dose})
                    </span>
                  ) : null}
                </span>
              ) : null}
            </SelectValue>
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
          onChange={(e) => setDoseOverride(e.target.value)}
          maxLength={50}
          placeholder={
            selectedMedication?.dose ??
            t("dashboard.medicationIntakeQuickAdd.dosePlaceholder")
          }
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">
          {t("dashboard.medicationIntakeQuickAdd.doseHint")}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="medication-intake-taken-at">
          {t("dashboard.medicationIntakeQuickAdd.timeLabel")}
        </Label>
        <DateTimeField
          id="medication-intake-taken-at"
          data-testid="medication-intake-quick-add-taken-at"
          value={takenAt}
          onChange={setTakenAt}
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
