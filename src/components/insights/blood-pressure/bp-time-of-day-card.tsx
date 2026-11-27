"use client";

import { Clock } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { ValueRow, type ValueRowItem } from "@/components/insights/value-row";
import {
  BP_PARTS_OF_DAY,
  type BpPartOfDay,
  type BpPartSummary,
} from "@/lib/analytics/bp-time-of-day";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { useBpTimeOfDay } from "@/lib/queries/use-bp-time-of-day";
import type { BpChartPart } from "./use-bp-time-of-day-state";
import { cn } from "@/lib/utils";

const PART_KEYS: Record<BpPartOfDay, string> = {
  morning: "insights.bpTimeOfDay.part.morning",
  midday: "insights.bpTimeOfDay.part.midday",
  evening: "insights.bpTimeOfDay.part.evening",
};

/** `HH:00` to `HH:59` of a part, from the hours the server sent. */
function hourRange(part: BpPartSummary): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${pad(part.startHour)}:00`,
    end: `${pad((part.endHour + 23) % 24)}:59`,
  };
}

/**
 * Blood pressure by part of the day (#1331): the morning, midday and evening
 * means side by side, with the choice that narrows the chart above to one
 * part at the card's top right. The page owns the choice (URL state), so the
 * chart and this card read the same one; the chosen part's value carries the
 * selected emphasis, the whole day emphasises none. Each part's hours are its
 * button's tooltip and accessible description. Every number is the server's
 * (`/api/measurements/blood-pressure/time-of-day`); a part below the reading
 * floor shows a dash, the reason as its hover and accessible text, rather
 * than a mean one reading can swing.
 */
export function BpTimeOfDayCard({
  days,
  chartPart,
  onChartPartChange,
}: {
  /** The chart's range, in days, so both read the same window. */
  days: number;
  chartPart: BpChartPart;
  onChartPartChange: (next: BpChartPart) => void;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const query = useBpTimeOfDay(days);
  const data = query.data;

  const hours = (part: BpPartOfDay): string | undefined => {
    const summary = data?.parts.find((p) => p.part === part);
    return summary
      ? t("insights.bpTimeOfDay.hourRange", hourRange(summary))
      : undefined;
  };

  const items: ValueRowItem[] = (data?.parts ?? []).map((part) => {
    const enough = part.systolic !== null && part.diastolic !== null;
    return {
      key: part.part,
      label: t(PART_KEYS[part.part]),
      value: enough ? (
        `${fmt.integer(part.systolic!)}/${fmt.integer(part.diastolic!)}`
      ) : (
        <>
          <span aria-hidden="true">{"\u2014"}</span>
          <span className="sr-only">{t("insights.bpTimeOfDay.notEnough")}</span>
        </>
      ),
      unit: enough ? "mmHg" : undefined,
      title: enough ? undefined : t("insights.bpTimeOfDay.notEnough"),
      selected: chartPart === part.part,
    };
  });

  return (
    <Card
      data-slot="bp-time-of-day"
      density="compact"
      aria-busy={query.isFetching || undefined}
    >
      <CardHeader>
        {/* Title left, the choice right; on a phone the choice takes its own
            line under the title, its four segments always on one row. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <TileHeader
            icon={Clock}
            title={t("insights.bpTimeOfDay.title")}
            titleAs="h2"
            id="bp-time-of-day-title"
          />
          <Segmented<BpChartPart>
            label={t("insights.bpTimeOfDay.filterLabel")}
            slot="bp-time-of-day-filter"
            size="sm"
            value={chartPart}
            onChange={onChartPartChange}
            options={[
              { value: "all", label: t("insights.bpTimeOfDay.filterAll") },
              ...BP_PARTS_OF_DAY.map((part) => ({
                value: part,
                label: t(PART_KEYS[part]),
                title: hours(part),
              })),
            ]}
          />
        </div>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <QueryErrorRow
            inset
            error={query.error}
            message={t("insights.bpTimeOfDay.error")}
            onRetry={() => void query.refetch()}
          />
        ) : data && data.readingCount === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("insights.bpTimeOfDay.emptyTitle")}
            description={t("insights.bpTimeOfDay.emptyDescription")}
          />
        ) : data ? (
          <ValueRow
            items={items}
            slot="bp-time-of-day-values"
            className={cn(
              "transition-opacity",
              query.isPlaceholderData && "opacity-60",
            )}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
