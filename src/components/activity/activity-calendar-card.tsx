"use client";

import { useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Target,
} from "lucide-react";

import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InlineAction } from "@/components/ui/inline-action";
import { Progress } from "@/components/ui/progress";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { ScorePill } from "@/components/ui/score-pill";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { TagChip } from "@/components/ui/tag-chip";
import { ActivityGoalsSheet } from "@/components/activity/activity-goals-sheet";
import { useActivityCalendar } from "@/hooks/use-activity-calendar";
import {
  useRecordCapabilities,
  holdsOwnerRights,
} from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { translateOrNull } from "@/lib/i18n/translate-code";
import { cn } from "@/lib/utils";
import type { ActivityCalendarResponse } from "@/lib/validations/activity-calendar";

type Period = "week" | "month";
type RatedMetric = "steps" | "activeMinutes" | "load";
type CalendarDay = ActivityCalendarResponse["days"][number];
type DayLevel = CalendarDay["level"]["steps"];

/**
 * One hue, rising intensity: the calendar shows more and less than usual,
 * not good and bad, so no status colour takes part. The bar is a graphic
 * (3:1 floor), the day number beside it stays foreground text.
 */
const LEVEL_BAR: Record<DayLevel, string> = {
  none: "bg-transparent",
  unrated: "bg-muted-foreground/60",
  in_progress: "bg-muted-foreground/30",
  low: "bg-chart-2/20",
  below: "bg-chart-2/40",
  usual: "bg-chart-2/60",
  above: "bg-chart-2/80",
  high: "bg-chart-2",
};

const LEGEND_LEVELS: DayLevel[] = ["low", "below", "usual", "above", "high"];

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

/**
 * The activity calendar (D1036): a week or a month of steps, active minutes,
 * workouts and training load against the person's own usual, with the goals
 * they set. Every figure comes from `/api/activity/calendar`; this component
 * draws, it does not compute.
 */
export function ActivityCalendarCard() {
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const capabilities = useRecordCapabilities();
  const [period, setPeriod] = useState<Period>("month");
  const [anchor, setAnchor] = useState<string | null>(null);
  const [metricChoice, setMetricChoice] = useState<RatedMetric | null>(null);
  const [goalsOpen, setGoalsOpen] = useState(false);
  // Each opening mounts a fresh sheet, so its draft starts from the stored
  // goals; keyed on the count rather than on `open`, so closing keeps the
  // sheet mounted for its exit animation.
  const [goalsOpenCount, setGoalsOpenCount] = useState(0);
  const query = useActivityCalendar(period, anchor);
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

  const ratedOptions = useMemo(() => {
    if (!data) return [] as RatedMetric[];
    return (["steps", "activeMinutes", "load"] as const).filter(
      (m) => data.available[m],
    );
  }, [data]);
  const metric: RatedMetric | null =
    metricChoice && ratedOptions.includes(metricChoice)
      ? metricChoice
      : (ratedOptions[0] ?? null);

  const periodLabel = data
    ? period === "month"
      ? new Intl.DateTimeFormat(locale, {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(dateOfKey(data.start))
      : t("activityCalendar.weekRange", {
          start: fmt.dateShortSmartCalendar(data.start),
          end: fmt.dateShortSmartCalendar(data.end),
        })
    : "";

  const formatMetric = (m: RatedMetric | "workouts", value: number) =>
    m === "load" ? fmt.number(value, 1) : fmt.integer(Math.round(value));

  const sportLabel = (sport: string) =>
    translateOrNull(t, `insights.workouts.sport.${sport}`) ?? sport;

  const weeklyGoalsSet =
    data !== undefined &&
    (data.goals.workoutsPerWeek !== null ||
      data.goals.activeMinutesPerWeek !== null ||
      data.goals.stepsPerWeek !== null);

  const levelText = (level: DayLevel) => t(`activityCalendar.level.${level}`);

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
    if (metric) parts.push(levelText(day.level[metric]));
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
      data-period={period}
      className="scroll-mt-28"
    >
      <CardHeader>
        <TileHeader
          icon={CalendarDays}
          title={t("activityCalendar.title")}
          right={
            <Segmented
              size="sm"
              label={t("activityCalendar.periodLabel")}
              slot="activity-calendar-period"
              value={period}
              onChange={(next) => {
                setPeriod(next);
                setAnchor(data ? data.start : null);
              }}
              options={[
                { value: "week", label: t("activityCalendar.period.week") },
                { value: "month", label: t("activityCalendar.period.month") },
              ]}
            />
          }
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isError ? (
          <QueryErrorRow
            inset
            error={query.error}
            message={t("activityCalendar.loadError")}
            onRetry={() => query.refetch()}
          />
        ) : !data ? (
          <div data-slot="activity-calendar-loading" className="space-y-2">
            <Skeleton className="h-8 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pointer-coarse:size-11"
                aria-label={t("activityCalendar.previous")}
                data-slot="activity-calendar-previous"
                onClick={() => setAnchor(data.previous)}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <p
                className="text-sm font-medium"
                data-slot="activity-calendar-label"
                aria-live="polite"
              >
                {periodLabel}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="pointer-coarse:size-11"
                aria-label={t("activityCalendar.next")}
                data-slot="activity-calendar-next"
                disabled={data.next === null}
                onClick={() => data.next && setAnchor(data.next)}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>

            {ratedOptions.length > 1 && metric ? (
              <Segmented
                size="sm"
                stretch
                label={t("activityCalendar.metricLabel")}
                slot="activity-calendar-metric"
                value={metric}
                onChange={setMetricChoice}
                options={ratedOptions.map((m) => ({
                  value: m,
                  label: t(`activityCalendar.metric.${m}`),
                }))}
              />
            ) : null}

            {!data.available.steps &&
            !data.available.activeMinutes &&
            !data.available.workouts &&
            !data.available.load ? (
              <EmptyState
                variant="plain"
                size="compact"
                title={t("activityCalendar.empty")}
                data-slot="activity-calendar-empty"
              />
            ) : (
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
                  {weeklyGoalsSet && period === "month" ? (
                    <span role="columnheader" className="w-5 shrink-0">
                      <span className="sr-only">
                        {t("activityCalendar.weekGoalsColumn")}
                      </span>
                    </span>
                  ) : null}
                </div>
                {rows.map((week, rowIndex) => {
                  const weekRow = data.weeks[rowIndex];
                  const allMet =
                    weekRow && weekRow.goals.length > 0
                      ? weekRow.goals.every((g) => g.met)
                      : null;
                  return (
                    <div role="row" key={week[0].date} className="flex gap-1">
                      {week.map((day) => {
                        const level = metric ? day.level[metric] : "none";
                        const value =
                          metric && !day.future ? day[metric] : null;
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
                              !day.inPeriod && "opacity-50",
                              day.date === data.today && "border-primary",
                            )}
                          >
                            <span
                              aria-hidden="true"
                              className={cn(
                                "text-xs tabular-nums",
                                day.future
                                  ? "text-muted-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {Number(day.date.slice(8))}
                            </span>
                            <span
                              aria-hidden="true"
                              className={cn(
                                "h-1.5 w-full max-w-8 rounded-full",
                                LEVEL_BAR[level],
                              )}
                            />
                            {period === "week" && value !== null ? (
                              <span
                                aria-hidden="true"
                                className="text-2xs text-foreground tabular-nums"
                              >
                                {formatMetric(metric as RatedMetric, value)}
                              </span>
                            ) : null}
                            {day.workoutCount > 0 ? (
                              <span
                                aria-hidden="true"
                                className="flex items-center gap-0.5"
                              >
                                {Array.from({
                                  length: Math.min(3, day.workoutCount),
                                }).map((_, i) => (
                                  <span
                                    key={i}
                                    className="bg-chart-1 size-1.5 rounded-full"
                                  />
                                ))}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                      {weeklyGoalsSet && period === "month" ? (
                        <span
                          role="cell"
                          className="flex w-5 shrink-0 items-center justify-center"
                          data-slot="activity-calendar-week-goal"
                          data-met={allMet === null ? "none" : String(allMet)}
                        >
                          {allMet ? (
                            <Check
                              className="text-success size-4"
                              aria-label={t("activityCalendar.weekGoalsMet")}
                            />
                          ) : allMet === false ? (
                            <span className="sr-only">
                              {t("activityCalendar.weekGoalsNotMet")}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}

            {metric ? (
              <div
                className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                data-slot="activity-calendar-legend"
              >
                <span>{t("activityCalendar.legend")}</span>
                {LEGEND_LEVELS.map((level) => (
                  <span key={level} className="inline-flex items-center gap-1">
                    <span
                      aria-hidden="true"
                      className={cn("h-1.5 w-4 rounded-full", LEVEL_BAR[level])}
                    />
                    {levelText(level)}
                  </span>
                ))}
                {data.baseline[metric] === null ? (
                  <span data-slot="activity-calendar-no-baseline">
                    {t("activityCalendar.noBaseline")}
                  </span>
                ) : null}
              </div>
            ) : null}

            <ul className="space-y-2" data-slot="activity-calendar-summary">
              {(["steps", "activeMinutes", "workouts", "load"] as const)
                .filter((m) => data.available[m])
                .map((m) => {
                  const s = data.summary[m];
                  // Compared over completed days only: today has not ended.
                  const delta =
                    s.completedValue !== null && s.usualToDate
                      ? (s.completedValue - s.usualToDate) / s.usualToDate
                      : null;
                  const running =
                    data.today >= data.start && data.today <= data.end;
                  return (
                    <li
                      key={m}
                      data-slot="activity-calendar-summary-row"
                      data-metric={m}
                      className="flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          {t(`activityCalendar.summary.${m}`, {
                            value:
                              s.value === null ? "–" : formatMetric(m, s.value),
                          })}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {s.usual !== null && s.completedDays === 0
                            ? t("activityCalendar.summary.firstDay")
                            : s.usualToDate === null
                              ? t("activityCalendar.summary.noUsual")
                              : running
                                ? t(
                                    "activityCalendar.summary.usualThroughYesterday",
                                    {
                                      value:
                                        s.completedValue === null
                                          ? "–"
                                          : formatMetric(m, s.completedValue),
                                      usual: formatMetric(m, s.usualToDate),
                                    },
                                  )
                                : t("activityCalendar.summary.usual", {
                                    value: formatMetric(m, s.usualToDate),
                                  })}
                        </p>
                      </div>
                      {delta !== null ? (
                        <ScorePill tone="neutral" numeric className="shrink-0">
                          {`${delta > 0 ? "+" : ""}${fmt.percent(delta)}`}
                        </ScorePill>
                      ) : null}
                    </li>
                  );
                })}
            </ul>

            {data.sports.length > 0 ? (
              <div
                className="flex flex-wrap gap-2"
                data-slot="activity-calendar-sports"
              >
                {data.sports.map((s) => (
                  <TagChip key={s.sportType}>
                    {t("activityCalendar.sportCount", {
                      sport: sportLabel(s.sportType),
                      count: fmt.integer(s.count),
                    })}
                  </TagChip>
                ))}
              </div>
            ) : null}

            <div className="space-y-2" data-slot="activity-calendar-goals">
              {data.goalProgress.map((g) => (
                <div
                  key={g.key}
                  className="space-y-1"
                  data-slot="activity-calendar-goal"
                  data-goal-key={g.key}
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="inline-flex items-center gap-1.5">
                      <Target
                        className="text-muted-foreground size-4"
                        aria-hidden="true"
                      />
                      {t(`activityCalendar.goal.${g.key}`)}
                    </span>
                    <span className="tabular-nums">
                      {t("activityCalendar.goalOf", {
                        value: fmt.integer(Math.round(g.value)),
                        target: fmt.integer(g.target),
                      })}
                    </span>
                  </div>
                  <Progress
                    value={Math.min(100, (g.value / g.target) * 100)}
                    aria-label={t(`activityCalendar.goal.${g.key}`)}
                  />
                </div>
              ))}
              {holdsOwnerRights(capabilities) ? (
                <InlineAction
                  type="button"
                  tone="primary"
                  size="xs"
                  data-slot="activity-calendar-set-goals"
                  onClick={() => {
                    setGoalsOpenCount((n) => n + 1);
                    setGoalsOpen(true);
                  }}
                >
                  {data.goalProgress.length > 0 || weeklyGoalsSet
                    ? t("activityCalendar.editGoals")
                    : t("activityCalendar.setGoals")}
                </InlineAction>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
      {data && holdsOwnerRights(capabilities) ? (
        <ActivityGoalsSheet
          key={goalsOpenCount}
          open={goalsOpen}
          onOpenChange={setGoalsOpen}
          goals={data.goals}
        />
      ) : null}
    </Card>
  );
}
