import { Check, Loader2, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationIntakeActionsProps {
  /** "take" | "skip" while the matching request is in flight, else null. */
  intakeLoading: string | null;
  onRecordIntake: (skipped: boolean) => void;
}

/**
 * Shared primary take / skip action row for the medication cards. These are
 * the most-tapped controls in HealthLog, so they keep the full default
 * button height (`min-h-11`) to clear the WCAG 44-px tap-target floor.
 *
 * Extracted from the generic and GLP-1 cards so the action row is shared
 * structurally rather than kept byte-equivalent by hand.
 */
export function MedicationIntakeActions({
  intakeLoading,
  onRecordIntake,
}: MedicationIntakeActionsProps) {
  const { t } = useTranslations();

  return (
    <div className="flex gap-2">
      <Button
        className="min-h-11 flex-1"
        onClick={() => onRecordIntake(false)}
        disabled={!!intakeLoading}
      >
        {intakeLoading === "take" ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <Check className="mr-1 h-4 w-4" />
        )}
        {t("medications.taken")}
      </Button>
      <Button
        variant="outline"
        className="min-h-11"
        onClick={() => onRecordIntake(true)}
        disabled={!!intakeLoading}
      >
        {intakeLoading === "skip" ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <SkipForward className="mr-1 h-4 w-4" />
        )}
        {t("medications.skipped")}
      </Button>
    </div>
  );
}
