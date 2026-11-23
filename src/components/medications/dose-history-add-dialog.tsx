"use client";

/**
 * The dose history's "+ Entry": the one intake form
 * (`intake-form/intake-form.tsx`) bound to the medication whose history is
 * open, so it shows no medication picker. Where the dose counts is said
 * under the fields before saving ("Counts for the 08:00 dose, as late"),
 * which replaces the "Attribute to this slot?" question this dialog used to
 * ask after the save.
 */

import { useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { invalidateKeys, refetchInactiveDailyReads } from "@/lib/query-keys";
import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import {
  runLogIntake,
  runUndoIntake,
} from "@/components/medications/use-medication-intake";
import {
  IntakeFormFields,
  intakeWriteOf,
  useIntakeFormState,
  type IntakeFormMedication,
} from "@/components/medications/intake-form/intake-form";
import type { QueryKey } from "@tanstack/react-query";
import type { LedgerSchedule } from "@/components/medications/dose-history-ledger";

export interface LedgerAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicationId: string;
  medicationName: string;
  /** The medication's configured dose, the dose field's starting value. */
  medicationDose?: string;
  schedules: LedgerSchedule[];
  /** The history's ledger key, refreshed alongside the medication reads. */
  ledgerKey: QueryKey;
}

export function LedgerAddDialog({
  open,
  onOpenChange,
  medicationId,
  medicationName,
  medicationDose = "",
  schedules,
  ledgerKey,
}: LedgerAddDialogProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  // The record this dose lands in, or null in the caller's own.
  const recordName = useActiveRecordName();
  const formId = useId();
  const medication = useMemo<IntakeFormMedication>(
    () => ({
      id: medicationId,
      name: medicationName,
      dose: medicationDose,
      schedules,
    }),
    [medicationId, medicationName, medicationDose, schedules],
  );
  const form = useIntakeFormState({ medication });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const med = { id: medicationId, name: medicationName };
    try {
      const ok = await runLogIntake({
        medication: med,
        ...intakeWriteOf(form),
        t,
        queryClient,
        recordName,
        formatTime: (at) => fmt.time(at),
        onFailure: setError,
        undoIntake: (eventId) =>
          runUndoIntake({ medication: med, eventId, t, queryClient }),
      });
      if (ok) {
        onOpenChange(false);
        // A history add can land a today-dated dose: the history window and
        // the unmounted Today reads refresh too.
        void invalidateKeys(queryClient, [ledgerKey]);
        void refetchInactiveDailyReads(queryClient);
      }
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
            disabled={busy}
            aria-busy={busy || undefined}
            data-slot="ledger-add-submit"
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
          void submit();
        }}
      >
        <IntakeFormFields
          form={form}
          medication={medication}
          idPrefix="ledger-add"
          error={error}
        />
      </form>
    </ResponsiveSheet>
  );
}
