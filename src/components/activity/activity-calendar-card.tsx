"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MenuSelect } from "@/components/ui/menu-select";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivityCalendar } from "@/hooks/use-activity-calendar";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { translateOrNull } from "@/lib/i18n/translate-code";
import type { ModuleSummaryMeasure } from "@/lib/settings/module-list-layout";
import { cn } from "@/lib/utils";
import type { ActivityCalendarResponse } from "@/lib/validations/activity-calendar";

type CalendarDay = ActivityCalendarResponse["days"][number];
type DayLevel = CalendarDay["level"]["steps"];
type Figure = "steps" | "activeMinutes" | "workouts" | "load";

/**
 * The series ink, rising intensity: the calendar shows more and less than
 * usual, not good and bad, so neither a status colour nor a hue takes part.
 * The bar is a graphic; the day number beside it is text and never dimmed
 * by opacity, so it keeps its contrast on every surface.
 */
const LEVEL_BAR: Record<DayLevel, string> = {
  none: "bg-transparent",
  unrated: "bg-muted-foreground/60",
  in_progress: "bg-muted-foreground/30",
  low: "bg-chart-1/20",
  below: "bg-chart-1/40",
  usual: "bg-chart-1/60",
  above: "bg-chart-1/80",
  high: "bg-chart-1",
};

const LEGEND_LEVELS: DayLevel[] = ["low", "below", "usual", "above", "high"];

export const CALENDAR_MEASURES: readonly ModuleSummaryMeasure[] = [
  "steps",
  "activeMinutes",
  "load",
];

/** The figures of the period; the load only beside the calendar on a wide screen. */
const FIGURES: readonly Figure[] = [
  "steps",
  "activeMinutes",
  "workouts",
  "load",
];

/** 2024-01-01 is a Monday: seven UTC days from it name the week's columns. */
function weekdayLabels(locale: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  return Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(Date.UTC(2024, 0, 1 + i))),
  );
}

function dateOfKey(key: string): Date {
  return new Date(`${key}T12:00:00.000Z`);
}

/** The measures the account has data for, in their fixed order. */
export function availableMeasures(
  data: Pick<ActivityCalendarResponse, "available"> | undefined,
): ModuleSummaryMeasure[] {
  if (!data) return [];
  return CALENDAR_MEASURES.filter((m) => data.available[m]);
}

/**
 * The summary of the workouts page (D1036, domain page template zone 3): a
 * month of steps, active minutes or training load against the person's own
 * usual, with the period's figures under a hairline (beside the month on a
 * wide screen). The month name is the card's title, between its arrows; the
 * measure is the card's one control, top right. Every figure and every
 * change comes from `/api/activity/calendar`; this component draws, it does
 * not compute.
 */
export function ActivityCalendarCard({
  measure: storedMeasure,
  onMeasureChange,
}: {
  /** The person's chosen measure ("Seite anpassen" › Anzeige). */
  measure: ModuleSummaryMeasure;
  onMeasureChange: (measure: ModuleSummaryMeasure) => void;
}) {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [anchor, setAnchor] = useState<string | null>(null);
  const query = useActivityCalendar("month", anchor);
  const data = query.data;
  const weekdays = useMemo(() => weekdayLabels(locale), [locale]);
  // A calendar day key names the same date everywhere: read it in UTC, where
  // its noon anchor sits, never in the viewer's zone.
  const dayNameFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }),
    [locale],
  );

  const measures = availableMeasures(data);
  // A measure the account has no data for falls back to the first it has.
  const measure: ModuleSummaryMeasure | null = measures.includes(storedMeasure)
    ? storedMeasure
    : (measures[0] ?? null);

  const periodLabel = data
    ? new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(dateOfKey(data.start))
    : "";

  const formatValue = (m: Figure, value: number) =>
    m === "load" ? fmt.number(value, 1) : fmt.integer(Math.round(value));

  const sportLabel = (sport: string) =>
    translateOrNull(t, `insights.workouts.sport.${sport}`) ?? sport;

  const dayLabel = (day: CalendarDay) => {
    const parts = [dayNameFormat.format(dateOfKey(day.date))];
    if (day.future) return parts.join(", ");
    if (day.steps !== null)
      parts.push(
        t("activityCalendar.cell.steps", { value: fmt.integer(day.steps) }),
      );
    if (day.activeMinutes !== null)
      parts.push(
        t("activityCalendar.cell.activeMinutes", {
          value: fmt.integer(day.activeMinutes),
        }),
      );
    if (day.workoutCount > 0)
      parts.push(
        t("activityCalendar.cell.workouts", {
          value: fmt.integer(day.workoutCount),
          sports: Object.keys(day.workoutsBySport).map(sportLabel).join(", "),
        }),
      );
    if (measure) parts.push(t(`activityCalendar.level.${day.level[measure]}`));
    return parts.join(", ");
  };

  const rows: CalendarDay[][] = [];
  if (data) {
    for (let i = 0; i < data.days.length; i += 7) {
      rows.push(data.days.slice(i, i + 7));
    }
  }

  return (
    <Card
      id="activity-calendar"
      data-slot="activity-calendar"
      className="scroll-mt-28"
    >
      <CardContent>
        {query.isError ? (
          <QueryErrorRow
            inset
            error={query.error}
            message={t("activityCalendar.loadError")}
            onRetry={() => query.refetch()}
          />
        ) : !data ? (
          <div data-slot="activity-calendar-loading" className="space-y-3">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-72 w-full rounded-lg" />
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 md:gap-6">
            <div className="min-w-0 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="-ml-2 flex min-w-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("activityCalendar.previous")}
                    data-slot="activity-calendar-previous"
                    onClick={() => setAnchor(data.previous)}
                  >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                  </Button>
                  <h2
                    className="truncate text-base font-semibold"
                    data-slot="activity-calendar-label"
                    aria-live="polite"
                  >
                    {periodLabel}
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("activityCalendar.next")}
                    data-slot="activity-calendar-next"
                    disabled={data.next === null}
                    onClick={() => data.next && setAnchor(data.next)}
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                {measure && measures.length > 1 ? (
                  <MenuSelect
                    value={measure}
                    label={t("insights.workouts.customize.calendarShows")}
                    slot="activity-calendar-measure"
                    options={measures.map((m) => ({
                      value: m,
                      label: t(`activityCalendar.metric.${m}`),
                    }))}
                    onChange={onMeasureChange}
                  />
                ) : null}
              </div>

              <div role="table" aria-label={periodLabel} className="space-y-1">
                <div role="row" className="flex gap-1">
                  {weekdays.map((label, i) => (
                    <span
                      key={i}
                      role="columnheader"
                      className="text-muted-foreground flex-1 text-center text-xs"
                    >
                      {label}
                    </span>
                  ))}
                </div>
                {rows.map((week) => (
                  <div role="row" key={week[0].date} className="flex gap-1">
                    {week.map((day) => {
                      const level = measure ? day.level[measure] : "none";
                      return (
                        <div
                          role="cell"
                          key={day.date}
                          data-slot="activity-calendar-day"
                          data-date={day.date}
                          data-level={level}
                          aria-label={dayLabel(day)}
                          className={cn(
                            "flex min-h-11 flex-1 flex-col items-center gap-1 rounded-lg border px-0.5 py-1",
                            day.date === data.today &&
                              "border-primary ring-primary ring-1",
                          )}
                        >
                          <span
                            aria-hidden="true"
                            className={cn(
                              "text-xs tabular-nums",
                              day.future || !day.inPeriod
                                ? "text-muted-foreground"
                                : "text-foreground",
                            )}
                          >
                            {Number(day.date.slice(8))}
                          </span>
                          <span
                            aria-hidden="true"
                            className={cn(
                              "h-1 w-full max-w-8 rounded-full",
                              LEVEL_BAR[level],
                              !day.inPeriod && "opacity-50",
                            )}
                          />
                          <span
                            aria-hidden="true"
                            className="flex h-1 items-center gap-0.5"
                          >
                            {Array.from({
                              length: Math.min(3, day.workoutCount),
                            }).map((_, i) => (
                              <span
                                key={i}
                                className="bg-chart-1 size-1 rounded-full"
                              />
                            ))}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {measure ? (
                <div
                  className="text-muted-foreground flex items-center justify-between gap-2 text-xs whitespace-nowrap"
                  data-slot="activity-calendar-legend"
                >
                  <span className="min-w-0 truncate">
                    {data.baseline[measure] === null
                      ? t("activityCalendar.noBaseline")
                      : t("activityCalendar.caption")}
                  </span>
                  {data.baseline[measure] === null ? null : (
                    <span className="flex shrink-0 items-center gap-0.5">
                      <span className="mr-0.5">
                        {t("activityCalendar.legendLess")}
                      </span>
                      {LEGEND_LEVELS.map((level) => (
                        <span
                          key={level}
                          aria-hidden="true"
                          className={cn(
                            "h-1 w-2.5 rounded-full",
                            LEVEL_BAR[level],
                          )}
                        />
                      ))}
                      <span className="ml-0.5">
                        {t("activityCalendar.legendMore")}
                      </span>
                    </span>
                  )}
                </div>
              ) : null}
            </div>

            <dl
              data-slot="activity-calendar-summary"
              className={cn(
                "grid grid-cols-3 gap-3 border-t pt-4",
                "md:flex md:flex-col md:gap-0 md:divide-y md:border-t-0 md:border-l md:pt-0 md:pl-6",
              )}
            >
              {FIGURES.filter((m) => data.available[m]).map((m) => {
                const s = data.summary[m];
                return (
                  <div
                    key={m}
                    data-slot="activity-calendar-figure"
                    data-metric={m}
                    className={cn(
                      "grid min-w-0 content-start gap-0.5",
                      "md:flex-1 md:grid-cols-[minmax(0,1fr)_auto_3.5rem] md:content-center md:items-baseline md:gap-4 md:py-3",
                      m === "load" && "hidden md:grid",
                    )}
                  >
                    <dt className="text-muted-foreground truncate text-xs md:text-sm">
                      {t(`activityCalendar.metric.${m}`)}
                    </dt>
                    <dd className="text-lg font-semibold tabular-nums md:text-right md:text-2xl">
                      {s.value === null ? "–" : formatValue(m, s.value)}
                    </dd>
                    <dd
                      data-slot="activity-calendar-change"
                      className={cn(
                        "min-h-4 text-xs font-medium tabular-nums md:text-right",
                        s.change !== null && s.change > 0
                          ? "text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {s.change === null
                        ? null
                        : `${s.change > 0 ? "+" : ""}${fmt.percent(s.change)}`}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
