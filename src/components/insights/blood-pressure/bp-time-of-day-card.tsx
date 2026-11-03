"use client";

import { Clock } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import type {
  BpPartOfDay,
  BpPartSummary,
} from "@/lib/analytics/bp-time-of-day";
import { pluralKey } from "@/lib/i18n/plural";
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
 * means side by side, the morning-minus-evening difference, and the control
 * that narrows the chart above to one part. Every number is the server's
 * (`/api/measurements/blood-pressure/time-of-day`); a part below the reading
 * floor shows its count and says so rather than a mean one reading can swing.
 * The card is its own text equivalent: there is no graphic to describe.
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
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const query = useBpTimeOfDay(days);
  const data = query.data;

  // A signed difference: `+` spelled out, the minus from the formatter.
  const signed = (n: number) => (n > 0 ? `+${fmt.integer(n)}` : fmt.integer(n));

  return (
    <Card data-slot="bp-time-of-day" aria-busy={query.isFetching || undefined}>
      <CardHeader>
        <TileHeader
          icon={Clock}
          title={t("insights.bpTimeOfDay.title")}
          titleAs="h2"
          id="bp-time-of-day-title"
        />
        <CardDescription>
          {t("insights.bpTimeOfDay.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
          <div
            className={cn(
              "space-y-3 transition-opacity",
              query.isPlaceholderData && "opacity-60",
            )}
          >
            <ul
              aria-labelledby="bp-time-of-day-title"
              className="grid grid-cols-3 gap-x-3 gap-y-2"
            >
              {data.parts.map((part) => (
                <li
                  key={part.part}
                  data-slot={`bp-time-of-day-${part.part}`}
                  className="min-w-0 space-y-0.5"
                >
                  <p className="text-muted-foreground text-xs tracking-wide uppercase">
                    {t(PART_KEYS[part.part])}
                  </p>
                  {part.systolic !== null && part.diastolic !== null ? (
                    <p className="flex flex-wrap items-baseline gap-x-1 text-base font-semibold tabular-nums">
                      <span>{`${fmt.integer(part.systolic)}/${fmt.integer(part.diastolic)}`}</span>
                      <span className="text-muted-foreground text-xs font-normal">
                        mmHg
                      </span>
                    </p>
                  ) : (
                    <p className="text-sm">
                      {t("insights.bpTimeOfDay.notEnough")}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs tabular-nums">
                    {t(
                      pluralKey(
                        "insights.bpTimeOfDay.readings",
                        part.readingCount,
                        locale,
                      ),
                      { count: fmt.integer(part.readingCount) },
                    )}
                  </p>
                  {part.pulse !== null ? (
                    <p className="text-muted-foreground text-xs tabular-nums">
                      {t("insights.bpTimeOfDay.pulse", {
                        value: fmt.integer(part.pulse),
                      })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            {data.morningEveningDifference ? (
              <p className="text-sm" data-slot="bp-time-of-day-difference">
                {t("insights.bpTimeOfDay.difference", {
                  systolic: signed(data.morningEveningDifference.systolic),
                  diastolic: signed(data.morningEveningDifference.diastolic),
                })}
              </p>
            ) : (
              <p className="text-sm" data-slot="bp-time-of-day-difference">
                {t("insights.bpTimeOfDay.differencePending", {
                  min: fmt.integer(data.minReadings),
                })}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              {t("insights.bpTimeOfDay.hours", {
                morning: t(
                  "insights.bpTimeOfDay.hourRange",
                  hourRange(data.parts[0]),
                ),
                midday: t(
                  "insights.bpTimeOfDay.hourRange",
                  hourRange(data.parts[1]),
                ),
                evening: t(
                  "insights.bpTimeOfDay.hourRange",
                  hourRange(data.parts[2]),
                ),
              })}
            </p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <p
            className="text-muted-foreground text-xs"
            id="bp-time-of-day-filter-label"
          >
            {t("insights.bpTimeOfDay.filterLabel")}
          </p>
          <Segmented<BpChartPart>
            label={t("insights.bpTimeOfDay.filterLabel")}
            slot="bp-time-of-day-filter"
            stretch
            size="sm"
            // Full width on a phone, where four parts share 343 px; beside
            // the text from `md` up rather than stretched across the card.
            className="md:inline-flex md:w-auto"
            value={chartPart}
            onChange={onChartPartChange}
            options={[
              { value: "all", label: t("insights.bpTimeOfDay.filterAll") },
              { value: "morning", label: t(PART_KEYS.morning) },
              { value: "midday", label: t(PART_KEYS.midday) },
              { value: "evening", label: t(PART_KEYS.evening) },
            ]}
          />
        </div>
      </CardContent>
    </Card>
  );
}
