"use client";

/**
 * v1.16.11 (#316) — confirm dialog for the medications-page "Alle
 * fälligen einnehmen" header action. Lists every currently-due
 * medication (name + dose + matched dose window) and records all of them
 * in one confirmed action through `runTakeAllDue` (the per-medication
 * intake loop — see `take-all-due.ts` for the loop-vs-bulk decision).
 *
 * The component owns only the dialog shell + the submitting guard; the
 * derivation and the recording orchestration live in the pure,
 * injection-tested module. While a run is in flight the dialog refuses
 * to close (mirroring `LogInjectionSiteDialog`'s controlled-submit
 * contract) so the summary toast is never orphaned mid-request.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { useTranslations } from "@/lib/i18n/context";
import { useActiveRecordName } from "@/hooks/use-record-capabilities";
import { MedicationNote } from "@/components/medications/medication-note";
import { formatDose } from "@/lib/medications/format-dose";
import { formatTimeWindowRange } from "@/lib/time-window-format";
import {
  runTakeAllDue,
  type DueMedication,
} from "@/components/medications/take-all-due";

export interface TakeAllDueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The currently-due set from `deriveDueMedications`, in page order. */
  dueMedications: DueMedication[];
}

export function TakeAllDueDialog({
  open,
  onOpenChange,
  dueMedications,
}: TakeAllDueDialogProps) {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();
  const recordName = useActiveRecordName();
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await runTakeAllDue({
        medications: dueMedications,
        t,
        queryClient,
        recordName,
      });
      // Close regardless of partial failures — the summary toast carries
      // the counts and failed medications stay due on the page behind it.
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(next) => {
        // Refuse to close while the take loop is in flight.
        if (submitting && !next) return;
        onOpenChange(next);
      }}
      title={t("medications.takeAllDue.dialogTitle")}
      description={t("medications.takeAllDue.dialogDescription")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="min-h-11 sm:min-h-9"
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting || dueMedications.length === 0}
            className="min-h-11 sm:min-h-9"
            data-testid="take-all-due-confirm"
          >
            {submitting ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <CheckCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {t("medications.takeAllDue.confirm", {
              count: dueMedications.length,
            })}
          </Button>
        </>
      }
    >
      <ul className="space-y-2" data-testid="take-all-due-list">
        {dueMedications.map((med) => (
          <li
            key={med.id}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="min-w-0">
              <span className="block truncate">
                <span className="font-medium">{med.name}</span>
                {med.dose ? (
                  <span className="text-muted-foreground">
                    {" "}
                    — {formatDose(med.dose, t)}
                  </span>
                ) : null}
              </span>
              <MedicationNote
                note={med.note}
                slot="take-all-due-note"
                className="mt-0.5"
              />
            </span>
            {med.window ? (
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {formatTimeWindowRange(
                  med.window.start,
                  med.window.end,
                  locale,
                )}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </ResponsiveSheet>
  );
}
