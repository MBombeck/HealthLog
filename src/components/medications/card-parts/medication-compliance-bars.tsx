import { Flame } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { useTranslations } from "@/lib/i18n/context";

interface MedicationComplianceBarsProps {
  rate7: number;
  rate30: number;
  streak: number;
}

/**
 * Shared 7-day / 30-day compliance bars plus the day-streak flame for the
 * medication cards. Extracted from the generic and GLP-1 cards so the bars
 * are structurally identical rather than hand-synced.
 *
 * The streak flame uses the canonical `text-dracula-orange` warning/streak
 * token (globals.css). The generic card historically drifted onto Tailwind
 * stock `text-orange-400`; unifying here closes that token gap.
 */
export function MedicationComplianceBars({
  rate7,
  rate30,
  streak,
}: MedicationComplianceBarsProps) {
  const { t } = useTranslations();

  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t("medications.compliance7d")}
          </span>
          <span className="font-medium">{rate7}%</span>
        </div>
        {/* aria-label so the bar has an accessible name. */}
        <Progress
          value={rate7}
          className="h-2"
          aria-label={t("medications.compliance7d")}
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t("medications.compliance30d")}
          </span>
          <span className="font-medium">{rate30}%</span>
        </div>
        <Progress
          value={rate30}
          className="h-2"
          aria-label={t("medications.compliance30d")}
        />
      </div>

      <div className="flex items-center gap-4 text-xs">
        {streak > 0 && (
          <span className="text-dracula-orange flex items-center gap-1 font-medium">
            <Flame className="h-3.5 w-3.5" />
            {streak} {t("medications.dayStreak")}
          </span>
        )}
      </div>
    </div>
  );
}
