"use client";

import { Progress } from "@/components/ui/progress";
import { useFormatters, useTranslations } from "@/lib/i18n/context";

/**
 * One adherence row of the table cell: window, mini bar, and the rate, or a
 * dash read out as "no doses yet" when the window has nothing to score.
 */
export function TableComplianceRow({
  days,
  rate,
}: {
  days: number;
  rate: number | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground w-8 shrink-0 tabular-nums">
        {t("medications.tableComplianceDays", { days })}
      </span>
      <Progress
        value={rate ?? 0}
        className="h-1.5 w-14"
        aria-label={t("medications.complianceWindow", { days })}
      />
      {rate === null ? (
        <span
          className="text-muted-foreground w-9 text-right"
          title={t("medications.complianceNoDoses")}
        >
          <span aria-hidden="true">–</span>
          <span className="sr-only">{t("medications.complianceNoDoses")}</span>
        </span>
      ) : (
        <span className="w-9 text-right font-medium tabular-nums">
          {fmt.number(Math.round(rate))}%
        </span>
      )}
    </div>
  );
}
