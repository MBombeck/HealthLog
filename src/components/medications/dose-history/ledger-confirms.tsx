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
