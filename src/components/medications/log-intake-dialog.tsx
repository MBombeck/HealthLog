"use client";

/**
 * v1.14.0 — manual intake logger reachable from the medications-page
 * "Add" choice. The top-of-page Add button now offers two paths: create a
 * new medication (the existing wizard) or LOG AN INTAKE against an existing
 * medication — including a backdated one.
 *
 * It renders the one intake form (`intake-form/intake-form.tsx`): a
 * medication, taken or skipped, a time that defaults to "now" but accepts
 * any past instant, the dose, and where the dose counts. It submits
 * to the existing `POST /api/medications/{id}/intake` route: `takenAt`
 * carries the (possibly backdated) instant, and a chosen slot supplies
 * `scheduledFor` so the write routes through the server's canonical slot
 * upsert — the same snap/upsert path a normal "Taken" tap uses — keeping
 * the one-row-per-dose-slot invariant intact. No new endpoint is minted.
 *
 * The submit orchestration lives in the pure, injection-tested
 * `runLogIntake` (see `use-medication-intake.ts`); this component owns only
 * the form state + the medication/slot pickers.
 */

import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useAuth } from "@/hooks/use-auth";
import {
  resolveMedicationSelectionId,
  type DefaultMedicationOption,
} from "@/lib/medications/default-medication";
import {
  runLogIntake,
  logIntakeUndo,
} from "@/components/medications/use-medication-intake";
import {
  IntakeFormFields,
  intakeWriteOf,
  useIntakeFormState,
} from "@/components/medications/intake-form/intake-form";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { EmptyState } from "@/components/ui/empty-state";

interface LogIntakeSchedule {
  windowStart: string;
  windowEnd: string;
  daysOfWeek: string | null;
  timesOfDay?: string[];
  label: string | null;
  dose: string | null;
}

export interface LogIntakeMedication extends DefaultMedicationOption {
  dose: string;
  /** #1371 — the person's own note, shown under the picker when present. */
  note?: string | null;
  schedules: LogIntakeSchedule[];
}

export interface LogIntakeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active medications the user can log against. */
  medications: LogIntakeMedication[];
}

export function LogIntakeDialog({
  open,
  onOpenChange,
  medications,
}: LogIntakeDialogProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const recordName = useActiveRecordName();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userTz = user?.timezone || DEFAULT_TIMEZONE;
  const formId = useId();

  const [medicationOverride, setMedicationOverride] = useState<string | null>(
    null,
  );
  const [selectionNow] = useState(() => new Date());
  const medicationId =
    resolveMedicationSelectionId(
      medications,
      medicationOverride,
      selectionNow,
      userTz,
    ) ?? "";
  const selected = useMemo(
    () => medications.find((m) => m.id === medicationId),
    [medications, medicationId],
  );
  const form = useIntakeFormState({ medication: selected });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    const write = intakeWriteOf(form);
    const med = { id: selected.id, name: selected.name };
    try {
      const ok = await runLogIntake({
        medication: med,
        ...write,
        t,
        queryClient,
        recordName,
        formatTime: (at) => fmt.time(at),
        onFailure: setError,
        undoIntake: logIntakeUndo({ medication: med, t, queryClient, fmt }),
      });
      if (ok) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title={t("medications.intakeForm.title")}
      description={t("medications.intakeForm.description")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy || medications.length === 0 || !medicationId}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || medications.length === 0 || !medicationId) return;
          void submit();
        }}
      >
        {medications.length === 0 ? (
          <EmptyState
            variant="plain"
            title={t("medications.intakeForm.noMedications")}
          />
        ) : (
          <IntakeFormFields
            form={form}
            medication={selected}
            medications={medications}
            onMedicationChange={setMedicationOverride}
            idPrefix="log-intake"
            error={error}
          />
        )}
      </form>
    </ResponsiveSheet>
  );
}
