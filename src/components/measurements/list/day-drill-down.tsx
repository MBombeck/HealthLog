"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { formatDateTime } from "@/lib/format";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import { sleepStageLabel, type Measurement } from "./list-model";

/**
 * The lazy drill-down for a collapsed day or night.
 * Fires a separate `GET /api/measurements?type=…&dayKey=…` only when
 * the row is expanded; the result is rendered as a nested list of the
 * per-sample chunks that summed into the parent row's daily total.
 */
export function DayDrillDown({
  type,
  dayKey,
  unit,
  layout,
}: {
  type: string;
  dayKey: string;
  unit: string;
  layout: "desktop" | "mobile";
}) {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.measurementDrilldown(type, dayKey),
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("type", type);
      params.set("dayKey", dayKey);
      params.set("sortDir", "asc");
      return apiGet<{ measurements: Measurement[] }>(
        `/api/measurements?${params}`,
      );
    },
    enabled: isAuthenticated,
    // The drill-down is per-day — once fetched it rarely needs to
    // re-fetch (the underlying day has already stabilised for
    // anything older than the drain's 36 h cutoff). Keep it cached
    // for the session.
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 py-2 text-xs">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
        {t("common.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <QueryErrorRow
        error={error}
        slot="measurement-drilldown-error"
        message={t("measurements.loadError")}
        onRetry={() => void refetch()}
        className={layout === "desktop" ? "m-2" : "mt-2"}
      />
    );
  }
  const rows = data?.measurements ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        variant="plain"
        size="compact"
        title={t("measurements.emptyDescription")}
      />
    );
  }
  // For SLEEP_DURATION the drill-down rows are stage segments;
  // render the stage label + minutes instead of a bare value + unit.
  const isSleep = type === "SLEEP_DURATION";
  if (layout === "desktop") {
    return (
      <div className="bg-muted/40 space-y-1 p-2">
        {rows.map((s) => (
          <div
            key={s.id}
            className="flex items-center justify-between gap-3 px-2 py-1 text-xs"
          >
            <span className="text-muted-foreground tabular-nums">
              {isSleep
                ? sleepStageLabel(s.sleepStage, t)
                : formatDateTime(s.measuredAt)}
            </span>
            <span className="font-medium tabular-nums">
              {isSleep
                ? formatDurationMinutes(s.value, t)
                : `${s.value} ${unit}`}
            </span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="bg-muted/40 mt-2 space-y-1 rounded-md p-2">
      {rows.map((s) => (
        <div
          key={s.id}
          className="flex items-center justify-between gap-2 px-1 py-1 text-xs"
        >
          <span className="text-muted-foreground tabular-nums">
            {isSleep
              ? sleepStageLabel(s.sleepStage, t)
              : formatDateTime(s.measuredAt)}
          </span>
          <span className="font-medium tabular-nums">
            {isSleep ? formatDurationMinutes(s.value, t) : `${s.value} ${unit}`}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Sub-caption for a per-night sleep row: the row's value is the day's sleep,
 * main night plus naps, so the caption says how many naps it includes, and
 * the night's mid-sleep awakenings when present.
 */
export function SleepNightCaption({ m }: { m: Measurement }) {
  const { t } = useTranslations();
  const napCount = m.napCount ?? 0;
  const awakenings = m.awakenings ?? 0;
  const parts: string[] = [];
  if (napCount > 0) {
    parts.push(t("measurements.sleepNapCaption", { count: String(napCount) }));
  }
  if (awakenings > 0) {
    parts.push(
      t("measurements.sleepAwakeningsCaption", { count: String(awakenings) }),
    );
  }
  if (parts.length === 0) return null;
  return (
    <span className="text-muted-foreground ml-2 text-xs font-normal">
      {parts.join(" · ")}
    </span>
  );
}
