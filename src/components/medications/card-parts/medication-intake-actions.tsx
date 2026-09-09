import { Check, Loader2, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";

interface MedicationIntakeActionsProps {
  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  /**
   * Record the displayed dose. The card binds the second `scheduledFor`
   * argument to the slot it is currently showing (v1.12.3), so the buttons
   * here just forward the skip flag.
   */
  onRecordIntake: (skipped: boolean) => void;
}

/**
 * Shared primary take / skip action row for the medication cards. These are
 * the most-tapped controls in HealthLog, so they keep the full default
 * button height (`min-h-11`) to clear the WCAG 44-px tap-target floor.
 *
 * Extracted from the generic and GLP-1 cards so the action row is shared
 * structurally rather than kept byte-equivalent by hand.
 *
 * Both buttons carry a `data-slot`. They are the only controls on the card
 * that write, and their labels are i18n copy that also collapses to an icon
 * on the narrow card — an e2e journey addressing them by text would be
 * asserting the translation, not the control.
 */
export function MedicationIntakeActions({
  intakeLoading,
  onRecordIntake,
}: MedicationIntakeActionsProps) {
  const { t } = useTranslations();
  // v1.36.x — marking a dose taken or skipped is the verb the delegation was
  // written for. A read-only delegate sees the card and its schedule and no
  // action row; the card is otherwise unchanged.
  const { canAdd } = useRecordCapabilities();
  if (!canAdd) return null;

  return (
    <div className="flex gap-2">
      <Button
        data-slot="medication-intake-take"
        className="min-h-11 flex-1"
        onClick={() => onRecordIntake(false)}
        disabled={!!intakeLoading}
      >
        {intakeLoading === "take" ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Check className="h-4 w-4" />
        )}
        {t("medications.taken")}
      </Button>
      <Button
        data-slot="medication-intake-skip"
        variant="outline"
        className="min-h-11"
        onClick={() => onRecordIntake(true)}
        disabled={!!intakeLoading}
      >
        {intakeLoading === "skip" ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <SkipForward className="h-4 w-4" />
        )}
        {t("medications.skipped")}
      </Button>
    </div>
  );
}
