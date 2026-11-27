"use client";

import { Clock } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { InfoPopover } from "@/components/ui/info-popover";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { TileHeader } from "@/components/insights/tile-header";
import { ValueRow, type ValueRowItem } from "@/components/insights/value-row";
import type {
  BpPartOfDay,
  BpPartSummary,
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
 * means side by side and the morning-minus-evening difference. The control
 * that narrows the chart to one part sits in the chart's header
 * (`BpPartOfDayControl`), beside the range tabs it works with. Every number is the server's
 * (`/api/measurements/blood-pressure/time-of-day`); a part below the reading
 * floor shows a dash (with the reason as its hover and accessible text)
 * rather than a mean one reading can swing. The card is the three values;
 * what it means, the hours of each part and the morning-minus-evening
 * difference sit behind its (i).
 * The card is its own text equivalent: there is no graphic to describe.
 */
export function BpTimeOfDayCard({
  days,
}: {
  /** The chart's range, in days, so both read the same window. */
  days: number;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const query = useBpTimeOfDay(days);
  const data = query.data;

  // A signed difference: `+` spelled out, the minus from the formatter.
  const signed = (n: number) => (n > 0 ? `+${fmt.integer(n)}` : fmt.integer(n));

  // What the card means and how its parts are cut sits behind the (i): the
  // card itself is the three values.
  const about = data
    ? [
        t("insights.bpTimeOfDay.description"),
        t("insights.bpTimeOfDay.hours", {
          morning: t(
            "insights.bpTimeOfDay.hourRange",
            hourRange(data.parts[0]),
          ),
          midday: t("insights.bpTimeOfDay.hourRange", hourRange(data.parts[1])),
          evening: t(
            "insights.bpTimeOfDay.hourRange",
            hourRange(data.parts[2]),
          ),
        }),
        data.morningEveningDifference
          ? t("insights.bpTimeOfDay.difference", {
              systolic: signed(data.morningEveningDifference.systolic),
              diastolic: signed(data.morningEveningDifference.diastolic),
            })
          : t("insights.bpTimeOfDay.differencePending", {
              min: fmt.integer(data.minReadings),
            }),
      ].join(" ")
    : t("insights.bpTimeOfDay.description");

  const items: ValueRowItem[] = (data?.parts ?? []).map((part) => {
    const label = t(PART_KEYS[part.part]);
    const enough = part.systolic !== null && part.diastolic !== null;
    return {
      key: part.part,
      label,
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
    };
  });

  return (
    <Card
      data-slot="bp-time-of-day"
      density="compact"
      aria-busy={query.isFetching || undefined}
    >
      <CardHeader>
        <TileHeader
          icon={Clock}
          title={t("insights.bpTimeOfDay.title")}
          titleAs="h2"
          id="bp-time-of-day-title"
          right={
            <InfoPopover
              content={about}
              triggerDataSlot="bp-time-of-day-info"
            />
          }
        />
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

/**
 * The chart's part-of-day choice, top right in the blood pressure chart's
 * header before the range tabs. The segments name themselves; the group's
 * name is for assistive tech only.
 */
export function BpPartOfDayControl({
  value,
  onChange,
}: {
  value: BpChartPart;
  onChange: (next: BpChartPart) => void;
}) {
  const { t } = useTranslations();
  return (
    <Segmented<BpChartPart>
      label={t("insights.bpTimeOfDay.filterLabel")}
      slot="bp-time-of-day-filter"
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { value: "all", label: t("insights.bpTimeOfDay.filterAll") },
        { value: "morning", label: t(PART_KEYS.morning) },
        { value: "midday", label: t(PART_KEYS.midday) },
        { value: "evening", label: t(PART_KEYS.evening) },
      ]}
    />
  );
}
