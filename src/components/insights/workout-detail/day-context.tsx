"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight, CalendarDays, Moon, Smile } from "lucide-react";

import { ChartSkeleton } from "@/components/charts/chart-skeleton";
import { DayLink } from "@/components/day/day-link";
import { SectionHeading } from "@/components/ui/section-heading";
import { Card, CardContent } from "@/components/ui/card";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useModuleEnabled } from "@/hooks/use-module-enabled";
import { useMoodDay } from "@/hooks/use-mood-day";
import { useSleepNight } from "@/hooks/use-sleep-night";
import type { WorkoutDetailPayload } from "@/hooks/use-workouts";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { formatDurationMinutes } from "@/lib/i18n/duration";
import { MOOD_LABEL_KEYS } from "@/lib/mood/labels";

// Through the shared chart-runtime boundary, never a direct import — a
// second `from "recharts"` entry point mints its own copy of the library's
// chunk. Same pattern the pulse page uses for this very chart.
const IntradayPulseChart = dynamic(
  () =>
    import("@/components/charts/chart-runtime").then((mod) => ({
      default: mod.IntradayPulseChart,
    })),
  { ssr: false, loading: () => <ChartSkeleton /> },
);

const LINK_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1.5 text-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none";

const ROW_CLASS = "flex items-start gap-3 py-2";

const GLYPH_CLASS = "text-muted-foreground size-4 shrink-0";

export interface WorkoutDetailDayContextProps {
  workout: WorkoutDetailPayload;
}

/**
 * "That day" — the day around the session, rendered here rather than
 * linked to.
 *
 * After reading one workout the question is comparative and simultaneous:
 * how did the pulse settle afterwards, how had the person slept going into
 * it, how did the day feel. A comparison needs both halves on one screen,
 * so this section shows the day's own signals instead of handing off to
 * three aggregate-trend pages that carry no date.
 *
 * Every read is addressed by `workout.dayKey`, the local calendar day the
 * server resolved from `startedAt` in the user's timezone. Nothing here
 * derives a day from a timestamp.
 *
 * Absence and failure stay distinct: a night with nothing recorded and a
 * day with no mood entry each read as one muted sentence, while a failed
 * read gets `QueryErrorRow` with a retry. The two outbound links are
 * undated and named for what their targets actually deliver — trends and
 * history, not "that day".
 *
 * Module gating: the sleep row mounts only when `sleep` is on, so a
 * switched-off module never paints as a failed request. The intraday pulse
 * tile is heart-rate data and follows no module (the "AI analysis" switch
 * only governs model-written text). Mood has no module gate, so the section
 * always carries at least one part and the heading is never an orphan.
 */
export function WorkoutDetailDayContext({
  workout,
}: WorkoutDetailDayContextProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user, isAuthenticated } = useAuth();
  const sleepEnabled = useModuleEnabled("sleep");

  const sleep = useSleepNight(workout.dayKey, isAuthenticated && sleepEnabled);
  const mood = useMoodDay(workout.dayKey, isAuthenticated);

  const night = sleep.data?.main ?? null;
  const moodEntries = mood.entries ?? [];

  return (
    <section data-slot="workout-detail-day-context" className="space-y-3">
      <SectionHeading
        icon={CalendarDays}
        // `SubPageShell` tracks the card body edge for its own heading
        // rather than the container edge, so this heading takes the same
        // responsive card inset and every text run on the page shares one x.
        className="px-4 md:px-6"
        title={t("insights.workouts.detail.thatDayTitle")}
        action={
          // v1.42 — the date opens the whole day around the session: what
          // ran through it and everything else that happened.
          <span className="text-muted-foreground flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs">
            <span>{fmt.dateWithWeekdaySmart(new Date(workout.startedAt))}</span>
            <DayLink date={workout.dayKey} size="xs">
              {t("day.viewWholeDay")}
            </DayLink>
          </span>
        }
      />

      <IntradayPulseChart
        userTimezone={user?.timezone}
        initialDateKey={workout.dayKey}
      />

      <Card className="gap-2 py-3 md:py-4" data-slot="workout-detail-day-card">
        <CardContent>
          <div className="divide-border divide-y">
            {sleepEnabled ? (
              <div className={ROW_CLASS} data-slot="workout-detail-day-sleep">
                <Moon className={GLYPH_CLASS} aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-muted-foreground text-xs">
                    {t("insights.workouts.detail.daySleepTitle")}
                  </p>
                  {sleep.isError ? (
                    // A failed read is not an absent night.
                    <QueryErrorRow
                      onRetry={sleep.refetch}
                      slot="workout-detail-day-sleep-error"
                    />
                  ) : sleep.data === undefined ? (
                    // Nothing has answered yet. The absence line below is
                    // only ever shown for an answer that HAD no night.
                    <Skeleton className="h-4 w-32" />
                  ) : night ? (
                    <p className="text-sm">
                      {formatDurationMinutes(night.asleepMinutes, t)}
                      {night.awakenings > 0
                        ? ` · ${
                            night.awakenings === 1
                              ? t(
                                  "insights.workouts.detail.daySleepAwakeningsOne",
                                  { count: night.awakenings },
                                )
                              : t(
                                  "insights.workouts.detail.daySleepAwakeningsMany",
                                  { count: night.awakenings },
                                )
                          }`
                        : null}
                    </p>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {t("insights.workouts.detail.daySleepNone")}
                    </p>
                  )}
                </div>
                <Link
                  href="/insights/sleep"
                  data-slot="workout-detail-day-sleep-link"
                  className={LINK_CLASS}
                >
                  {t("insights.workouts.detail.sleepTrendsLink")}
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </div>
            ) : null}

            <div className={ROW_CLASS} data-slot="workout-detail-day-mood">
              <Smile className={GLYPH_CLASS} aria-hidden="true" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-muted-foreground text-xs">
                  {t("insights.workouts.detail.dayMoodTitle")}
                </p>
                {mood.isError ? (
                  <QueryErrorRow
                    onRetry={mood.refetch}
                    slot="workout-detail-day-mood-error"
                  />
                ) : mood.entries === undefined ? (
                  <Skeleton className="h-4 w-32" />
                ) : moodEntries.length > 0 ? (
                  // User data, so foreground — never muted.
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
                    {moodEntries.map((entry) => (
                      <li key={entry.id}>
                        {MOOD_LABEL_KEYS[entry.mood]
                          ? t(MOOD_LABEL_KEYS[entry.mood])
                          : entry.mood}
                        <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                          {fmt.time(new Date(entry.moodLoggedAt))}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    {t("insights.workouts.detail.dayMoodNone")}
                  </p>
                )}
              </div>
              <Link
                href="/mood"
                data-slot="workout-detail-day-mood-link"
                className={LINK_CLASS}
              >
                {t("insights.workouts.detail.moodHistoryLink")}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
