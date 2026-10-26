"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The "Slot zuordnen" confirm. Pinning is a deliberate, visible
 * decision, so the dialog names the consequence before the write: the dose
 * will count as taken LATE for that slot (the rate is served, never
 * flattered) and the row will carry the "zugeordnet" badge until released.
 */
export function PinConfirm({
  slotLabel,
  onConfirm,
  onCancel,
}: {
  slotLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-slot="ledger-pin-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("medications.detail.verlauf.pin.confirmTitle", {
              time: slotLabel,
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("medications.detail.verlauf.pin.confirmBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("medications.detail.verlauf.pin.confirmCancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            data-slot="ledger-pin-confirm-action"
          >
            {t("medications.detail.verlauf.pin.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Lightweight single-row delete confirm — the ledger does not need the full
 * bulk-delete state machine, just a guard. */
export function DeleteRowConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("medications.detail.intake.deleteRow.confirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("medications.detail.intake.deleteRow.confirmBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {t("medications.detail.intake.bulkDelete.cancelButton")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            className="bg-destructive dark:bg-destructive/60 hover:bg-destructive/90 text-white"
          >
            {t("medications.detail.intake.deleteRow.confirmAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
