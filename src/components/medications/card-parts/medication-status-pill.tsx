import { AlertCircle, AlertTriangle, CircleCheck } from "lucide-react";

import { formatTimeWindowRange } from "@/lib/time-window-format";
import { useTranslations } from "@/lib/i18n/context";
import type { MedicationWindowStatus } from "@/lib/medications/window-status";

interface MedicationStatusPillProps {
  /** Non-null window status; the caller guards `status &&` before rendering. */
  status: Exclude<MedicationWindowStatus, null>;
  windowStart: string;
  windowEnd: string;
}

/**
 * Shared take-now / overdue / very-overdue status pill for the medication
 * cards. Pairs the colour token with a Lucide glyph so colour-blind users
 * (red-green) can disambiguate the three tiers — WCAG 1.4.1 (Use of Color).
 *
 * Extracted from the generic and GLP-1 cards so the pill markup is shared
 * structurally rather than kept byte-equivalent by hand.
 */
export function MedicationStatusPill({
  status,
  windowStart,
  windowEnd,
}: MedicationStatusPillProps) {
  const { t, locale } = useTranslations();

  return (
    <p className="text-sm">
      <span
        className={
          "inline-flex items-center gap-1 font-medium " +
          (status === "in_window"
            ? "text-success"
            : status === "late"
              ? "text-dracula-yellow"
              : "text-warning")
        }
      >
        {status === "in_window" ? (
          <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />
        ) : status === "late" ? (
          <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        {status === "in_window"
          ? t("medications.takeNow")
          : status === "late"
            ? t("medications.overdue")
            : t("medications.veryOverdue")}
      </span>
      <span className="text-muted-foreground hidden sm:inline">
        {" "}
        — {formatTimeWindowRange(windowStart, windowEnd, locale)}
      </span>
    </p>
  );
}
