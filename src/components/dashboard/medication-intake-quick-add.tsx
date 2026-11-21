"use client";

import { localDateTimeValue } from "@/components/day/prefill";
import { useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Pill, Plus } from "lucide-react";
import Link from "next/link";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { ScheduleWindowInput } from "@/lib/medications/window-status";
import {
  resolveMedicationSelectionId,
  type DefaultMedicationOption,
} from "@/lib/medications/default-medication";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { apiGet } from "@/lib/api/api-fetch";
import { useIdempotentPost } from "@/lib/api/use-idempotent-post";
import {
  runLogIntake,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";
import {
  IntakeFormFields,
  intakeWriteOf,
  useIntakeFormState,
} from "@/components/medications/intake-form/intake-form";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { useMedicationDueThresholds } from "@/lib/queries/use-reminder-thresholds";

/**
 * v1.4.37 — dashboard "Hinzufügen" → "Medikamenteneinnahme" quick-add.
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
 * On success: `invalidateMedicationReads` (the bundle invalidation
 * paired with the forced inactive refetch of the Today digest and the
 * dashboard snapshot — this form also mounts from the capture picker on
 * every page, where both daily reads are unmounted and a bare bundle
 * invalidation would leave them stale until the next poll) PLUS the
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
  /**
   * The server's answer to "does this medication offer a dose today"
   * (active, intake tracked, course includes today; see
   * `src/lib/medications/intake-actionable.ts`). The list read always
   * carries it, so the picker renders from it and re-derives nothing.
   */
  intakeActionable: boolean;
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
  /**
   * v1.42 — a calendar day (`YYYY-MM-DD`) to start the date on, when the
   * form is opened from that day. Defaults to now.
   */
  defaultDate?: string;
}

export function MedicationIntakeQuickAdd({
  onSuccess,
  onCancel,
  footerSlot,
  defaultDate,
}: MedicationIntakeQuickAddProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const post = useIdempotentPost();
  // v1.16.9 — the auto-pick reasons in the PROFILE timezone (the same
  // source the cards use); Berlin stays the last-resort fallback so
  // logged-out mounts behave unchanged.
  const { user } = useAuth();
  const userTz = user?.timezone || DEFAULT_TIMEZONE;
  // The account's own late / missed thresholds decide which dose counts as
  // due for the preselection, the same tiers the medication cards show.
  const dueThresholds = useMedicationDueThresholds();
  // The record this dose lands in, or null in the caller's own.
  const recordName = useActiveRecordName();

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
        ? // #1040 — offer exactly what the cards, the table and "take
          // all" offer: a paused, record-only, not-yet-started or ended
          // course is not a dose to capture now.
          medicationsRaw.filter((m) => m.intakeActionable === true)
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectionNow] = useState(() => new Date());
  const formId = useId();
  const fmt = useFormatters();

  const medicationId =
    resolveMedicationSelectionId(
      medications,
      medicationOverride,
      selectionNow,
      dueThresholds,
      userTz,
    ) ?? "";
  const selectedMedication = sortedMedications.find(
    (m) => m.id === medicationId,
  );
  // The one intake form (`intake-form/intake-form.tsx`), the same fields the
  // medications page and the dose history show.
  const form = useIntakeFormState({
    medication: selectedMedication,
    initialTakenAt: localDateTimeValue(defaultDate),
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedMedication || loading) return;
    setLoading(true);
    setError(null);
    const med = { id: selectedMedication.id, name: selectedMedication.name };
    try {
      // The idempotent post survives a retried tap; the toast, the Undo
      // and the record naming are the shared ones.
      const ok = await runLogIntake({
        medication: med,
        ...intakeWriteOf(form),
        t,
        queryClient,
        recordName,
        formatTime: (at) => fmt.time(at),
        onFailure: setError,
        post: (url, body) => post(url, body),
        undoIntake: (eventId) =>
          runUndoIntake({ medication: med, eventId, t, queryClient }),
      });
      if (ok) onSuccess?.();
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
  // v1.4.38 — symmetry fix. The previous shape rendered the
  // CTA in the body and a footer with only the Close button, which
  // read as the dialog losing a save button. Now the body carries the
  // hint and the footer carries `<Cancel> <Link asChild>Medikament
  // anlegen</Link>` so the footer-slot promise holds across both
  // branches.
  if (!medicationsLoading && medications.length === 0) {
    // Medications exist, none offers a dose today: say that, rather than
    // "no medications yet", which would be untrue.
    const noneActionable =
      Array.isArray(medicationsRaw) && medicationsRaw.length > 0;
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
            {noneActionable
              ? t("dashboard.medicationIntakeQuickAdd.noneActionableCta")
              : t("dashboard.medicationIntakeQuickAdd.emptyCta")}
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
              {noneActionable
                ? t("dashboard.medicationIntakeQuickAdd.noneActionableTitle")
                : t("dashboard.medicationIntakeQuickAdd.emptyTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {noneActionable
                ? t(
                    "dashboard.medicationIntakeQuickAdd.noneActionableDescription",
                  )
                : t("dashboard.medicationIntakeQuickAdd.emptyDescription")}
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
      data-testid="medication-intake-quick-add-form"
    >
      <IntakeFormFields
        form={form}
        medication={selectedMedication}
        medications={sortedMedications}
        onMedicationChange={setMedicationOverride}
        idPrefix="medication-intake"
        testIdPrefix="medication-intake-quick-add"
        error={error}
      />

      {footerSlot ? createPortal(footerNode, footerSlot) : footerNode}
    </form>
  );
}
