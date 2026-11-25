"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";

import { ChartEmptyState } from "../chart-empty-state";
import { ChartErrorState } from "../chart-error-state";
import { ChartFooterReserve } from "../chart-skeleton";

/**
 * `HealthChart`'s body when there is no plot to draw: loading, a failed read,
 * or a window with no point in it.
 */
export function HealthChartFallback({
  state,
  mini,
  heightClass,
  dayLinks,
  dataTable,
  error,
  title,
  onRetry,
}: {
  state: "loading" | "error" | "empty";
  mini: boolean;
  heightClass: string;
  dayLinks: boolean;
  dataTable: boolean;
  error: unknown;
  title: string;
  onRetry: () => void;
}) {
  const { t } = useTranslations();
  if (state === "loading") {
    // A skeleton in the exact box the painted chart takes, so the card
    // height never jumps when the data lands.
    return (
      <>
        <Skeleton className={`w-full ${heightClass}`} />
        {mini ? null : (
          <ChartFooterReserve dayLinks={dayLinks} dataTable={dataTable} />
        )}
      </>
    );
  }
  if (state === "error") {
    // A failed read is an error with retry, never "no data in this range":
    // an outage must not read as "you have no measurements".
    return (
      <ChartErrorState
        error={error}
        title={t("charts.errorTitle")}
        actionLabel={t("common.retry")}
        actionContext={title}
        onAction={onRetry}
      />
    );
  }
  // Only a window with no daily point at all withholds the plot; any real
  // data, even one day, is drawn (with the sparse caption below it).
  return (
    <ChartEmptyState
      title={t("charts.noDataInRangeTitle")}
      description={t("charts.noDataInRangeDescription")}
    />
  );
}
