"use client";

import Link from "next/link";
import { HeartPulse, Loader2, Map as MapIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { getNumberFormat, getDateTimeFormat } from "@/lib/intl/formatter-cache";
import { useTranslations, useTimeFormatPreference } from "@/lib/i18n/context";
import {
  hourCycleOptions,
  type TimeFormatPreference,
} from "@/lib/format-locale";
import { iconForSport } from "@/lib/workouts/sport-icons";
import type { WorkoutListEntry } from "@/hooks/use-workouts";
import { Button } from "@/components/ui/button";

/**
 * v1.4.32 — workout list row primitive.
 *
 * Renders the canonical workouts list returned by `GET /api/workouts`.
 * Each row links to `/insights/workouts/[id]`. The visual shape mirrors
 * the dashboard tile primitives — single-line metadata strip with the
 * sport icon, the date, the duration, and (when present) the distance
 * + active-energy chips. The Apple Watch + Withings cross-source merge
 * runs server-side, so the list is already deduped by the time it
 * lands here.
 */

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
}

function formatDistanceKm(meters: number, locale: string): string {
  const km = meters / 1000;
  return getNumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: km < 10 ? 2 : 1,
  }).format(km);
}

function formatEnergy(kcal: number, locale: string): string {
  return getNumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(Math.round(kcal));
}

function formatDate(
  iso: string,
  locale: string,
  timeFormat: TimeFormatPreference,
): string {
  const d = new Date(iso);
  // Show the year whenever the workout is not from the current year, so a
  // "Do., 16. Dez." from a previous year is never mistaken for this year's.
  const showYear = d.getFullYear() !== new Date().getFullYear();
  return getDateTimeFormat(locale, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    ...(showYear ? { year: "numeric" as const } : {}),
    hour: "2-digit",
    minute: "2-digit",
    ...hourCycleOptions(timeFormat),
  }).format(d);
}

export interface WorkoutListProps {
  workouts: WorkoutListEntry[];
  className?: string;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  isFetchNextPageError?: boolean;
  onLoadMore?: () => void;
}

export function WorkoutList({
  workouts,
  className,
  hasNextPage = false,
  isFetchingNextPage = false,
  isFetchNextPageError = false,
  onLoadMore,
}: WorkoutListProps) {
  const { t, locale } = useTranslations();
  const timeFormat = useTimeFormatPreference();

  return (
    <ul
      data-slot="workout-list"
      className={cn("divide-border divide-y rounded-lg border", className)}
    >
      {workouts.map((workout) => {
        const Icon = iconForSport(workout.sportType);
        const sportLabelKey = `insights.workouts.sport.${workout.sportType}`;
        const sportLabel = t(sportLabelKey);
        // Translation keys missing from one locale fall back to the
        // canonical sport-type string so a new HK enum value never
        // renders the raw `insights.workouts.sport.x` placeholder.
        const sportName =
          sportLabel === sportLabelKey ? workout.sportType : sportLabel;

        return (
          <li key={workout.id}>
            <Link
              href={`/insights/workouts/${encodeURIComponent(workout.id)}`}
              data-slot="workout-list-row"
              className={cn(
                "flex items-center gap-3 px-3 py-3 text-sm transition-colors",
                "hover:bg-accent focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
              )}
            >
              <span
                aria-hidden="true"
                className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full"
              >
                <Icon className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 truncate font-medium">
                  {sportName}
                  {/* #67 — discreet glyphs flag which sessions open rich
                      (map / HR curve). Muted so they never compete with
                      the sport name. */}
                  {workout.hasRoute ? (
                    <MapIcon
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-hidden="true"
                      data-slot="workout-list-glyph-route"
                    />
                  ) : null}
                  {workout.hasHrSeries ? (
                    <HeartPulse
                      className="text-muted-foreground size-3.5 shrink-0"
                      aria-hidden="true"
                      data-slot="workout-list-glyph-hr"
                    />
                  ) : null}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {formatDate(workout.startedAt, locale, timeFormat)}
                </span>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-xs">
                <span className="font-medium tabular-nums">
                  {formatDuration(workout.durationSec)}
                </span>
                <span className="text-muted-foreground flex flex-wrap justify-end gap-x-2 tabular-nums">
                  {workout.distanceM != null ? (
                    <span data-slot="workout-list-distance">
                      {formatDistanceKm(workout.distanceM, locale)} km
                    </span>
                  ) : null}
                  {workout.activeEnergyKcal != null ? (
                    <span data-slot="workout-list-energy">
                      {formatEnergy(workout.activeEnergyKcal, locale)} kcal
                    </span>
                  ) : null}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
      {hasNextPage ? (
        <li
          data-slot="workout-list-load-more"
          className="flex flex-col items-center gap-2 p-3"
        >
          {isFetchNextPageError ? (
            <p
              id="workout-list-load-more-error"
              role="alert"
              className="text-destructive text-center text-sm"
            >
              {t("insights.workouts.loadMoreError")}
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-44"
            disabled={isFetchingNextPage}
            aria-busy={isFetchingNextPage || undefined}
            aria-describedby={
              isFetchNextPageError ? "workout-list-load-more-error" : undefined
            }
            onClick={onLoadMore}
          >
            {isFetchingNextPage ? (
              <>
                <Loader2
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {t("insights.workouts.loadingMore")}
              </>
            ) : isFetchNextPageError ? (
              t("common.retry")
            ) : (
              t("insights.workouts.loadMore")
            )}
          </Button>
        </li>
      ) : null}
    </ul>
  );
}
